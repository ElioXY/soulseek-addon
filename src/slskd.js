// Minimal slskd REST client (official API shape: POST /api/v0/searches {searchText}).
// Auth: X-API-Key header (some versions also accept Bearer tokens).
// Version differences are isolated in enqueueDownload() — see notes there.

import { config } from "./config.js";
import { AUDIO_EXTS, decodeId, describeFile, encodeId, parseSoulseekMetadata, rankTracks, fallbackQueries } from "./audio.js";

function headers() {
  return { "Content-Type": "application/json", "X-API-Key": config.SLSKD_API_KEY };
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${config.SLSKD_URL}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`slskd ${method} ${path} -> ${res.status}`);
  const text = (await res.text()).trim();
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchSoulseek(query, { timeoutMs = config.SEARCH_TIMEOUT_MS } = {}) {
  // Official slskd: { searchText, searchTimeout(ms), responseLimit, fileLimit }.
  const search = await api("/api/v0/searches", {
    method: "POST",
    body: {
      searchText: query,
      searchTimeout: timeoutMs,
      responseLimit: 25,
      fileLimit: 200,
    },
  });
  const id = search?.id ?? search?.search?.id;
  if (!id) throw new Error("slskd did not return a search id");

  // Distributed search: poll until it completes or our timeout elapses.
  const deadline = Date.now() + timeoutMs + 2000;
  let responses = [];
  while (Date.now() < deadline) {
    const state = await api(`/api/v0/searches/${encodeURIComponent(id)}`).catch(() => null);
    responses = (await api(`/api/v0/searches/${encodeURIComponent(id)}/responses`).catch(() => [])) ?? [];
    const done = /completed|timedout|done/i.test(String(state?.state ?? ""));
    if (done && responses.length > 0) break;
    if (done) break;
    await sleep(750);
  }
  // Best-effort cleanup; ignore failures (old searches expire server-side).
  api(`/api/v0/searches/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});

  return toTracks(responses).slice(0, 20);
}

function toTracks(responses) {
  const out = [];
  for (const r of Array.isArray(responses) ? responses : []) {
    const username = r.username ?? r.user ?? "unknown";
    const files = r.files ?? r.fileList ?? [];
    for (const f of files) {
      const filename = f.filename ?? f.path ?? "";
      const dot = filename.lastIndexOf(".");
      if (dot < 0 || !AUDIO_EXTS.has(filename.slice(dot).toLowerCase())) continue;
      const meta = describeFile(filename, f);
      const parsed = parseSoulseekMetadata(filename);
      out.push({
        id: encodeId(username, filename),
        title: f.title ?? parsed.title,
        artist: f.artist ?? parsed.artist,
        album: f.album ?? parsed.album,
        duration: typeof f.length === "number" ? f.length : undefined,
        format: meta.format,
        audioQuality: meta.audioQuality,
        _username: username,
        _filename: filename,
        _size: f.size,
        _bitrate: meta.bitrate,
        _sampleRate: meta.sampleRate,
        _bitDepth: meta.bitDepth,
        _freeSlot: r.hasFreeUploadSlot === true,
        _speed: typeof r.uploadSpeed === "number" ? r.uploadSpeed : 0,
        _queue: typeof r.queueLength === "number" ? r.queueLength : 999999,
      });
    }
  }
  // Lossless first, then fast peers: free upload slot, higher speed, shorter
  // queue. BitChord evaluates matches in the order it is given, so sorting on
  // speed across the whole catalogue is how a listener asking for lossless was
  // handed the first 128kbps MP3 that answered — the FLAC was there, ranked
  // fifth. Within each quality tier the old speed ordering stands.
  const quality = (t) => (t.audioQuality === "LOSSLESS" ? 0 : 1);
  return out.sort((a, b) =>
    (quality(a) - quality(b)) ||
    (b._freeSlot - a._freeSlot) ||
    (b._speed - a._speed) ||
    (a._queue - b._queue)
  );
}

// slskd's QueueDownloadRequest.Size is a non-nullable long, so a request without
// "size" does not mean "ask the peer" — the model binder fills in 0, and the
// transfer is then aborted with "the remote size of N does not match expected
// size 0" and retried forever. A zero-size enqueue therefore poisons the file:
// every later attempt hits the same dead record, and the track never plays.
// The only safe request carries the exact remote size, so an unknown size means
// look it up, and no size at all means refuse to queue.
const usableSize = (n) => (Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined);

export async function enqueueDownload(id, size) {
  // slskd >= 0.25: POST /api/v0/transfers/downloads/{username} [{ filename, size }]
  // (verified against the 0.26 web UI bundle; older /api/v0/downloads is gone).
  const { username, filename } = decodeId(id);
  let bytes = usableSize(size);
  if (bytes === undefined) bytes = usableSize(await resolveSize(username, filename));
  if (bytes === undefined) {
    throw new Error(`size unknown for ${filename.split(/[\\/]/).pop()} — not queueing a 0-byte transfer`);
  }
  return api(`/api/v0/transfers/downloads/${encodeURIComponent(username)}`, {
    method: "POST",
    body: [{ filename, size: bytes }],
  });
}

// Cold-cache fallback: quick targeted search to learn the exact file size.
async function resolveSize(username, filename) {
  const base = filename.split(/[\\/]/).pop();
  const probe = base.replace(/\.[^.]+$/, "").slice(0, 60);
  const search = await api("/api/v0/searches", {
    method: "POST",
    body: { searchText: probe, searchTimeout: 6000, responseLimit: 10, fileLimit: 100 },
  }).catch(() => null);
  const sid = search?.id;
  if (!sid) return undefined;
  try {
    await sleep(config.SIZE_LOOKUP_MS);
    const responses = (await api(`/api/v0/searches/${encodeURIComponent(sid)}/responses`).catch(() => [])) ?? [];
    for (const r of Array.isArray(responses) ? responses : []) {
      if ((r.username ?? r.user) !== username) continue;
      for (const f of r.files ?? r.fileList ?? []) {
        if ((f.filename ?? f.path) === filename) {
          const bytes = Number(f.size);
          if (Number.isFinite(bytes) && bytes > 0) return bytes;
        }
      }
    }
  } finally {
    api(`/api/v0/searches/${encodeURIComponent(sid)}`, { method: "DELETE" }).catch(() => {});
  }
  return undefined;
}

// Drops a transfer from slskd's list, optionally with the file. Called when the
// addon deletes a played/evicted track: a completed record left behind makes the
// same track refuse to re-enqueue, so a replay would never download again.
// Best effort — the id may already be gone after a restart.
export async function removeTransfer(id, knownState) {
  if (config.MOCK_MODE) return false;
  let username;
  try {
    ({ username } = decodeId(id));
  } catch {
    return false;
  }
  const state = knownState ?? await downloadState(id).catch(() => null);
  if (!state?.id) return false;
  await api(
    `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(state.id)}?remove=true`,
    { method: "DELETE" }
  ).catch(() => {});
  return true;
}

// A record slskd will never finish: queued with size 0 (the old "retry without a
// size" path — slskd reads a missing size as zero) or failed outright. Those
// records poison the id: slskd retries them forever with the same size mismatch,
// and every new enqueue comes back as a duplicate, so the track can never be
// fetched again until the record is gone.
export function isDeadTransfer(state) {
  if (!state) return false;
  if (typeof state.size === "number" && state.size <= 0) return true;
  return /error|abort|exception|fail/i.test(String(state.state ?? ""));
}

// Clears the backlog of dead records a previous build left behind.
export async function purgeDeadTransfers() {
  if (config.MOCK_MODE) return 0;
  const list = await api("/api/v0/transfers/downloads").catch(() => null);
  const groups = Array.isArray(list) ? list : (list?.downloads ?? []);
  let purged = 0;
  for (const g of Array.isArray(groups) ? groups : []) {
    const username = g.username ?? g.user;
    const files = g.files ?? g.directories?.flatMap((d) => d.files ?? []) ?? [];
    for (const f of Array.isArray(files) ? files : []) {
      if (!username || !f?.id || !isDeadTransfer(f)) continue;
      await api(
        `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(f.id)}?remove=true`,
        { method: "DELETE" }
      ).catch(() => {});
      purged += 1;
    }
  }
  return purged;
}

// Bulk record cleanup (slskd keeps completed transfers in memory until asked).
export async function removeCompletedTransfers() {
  if (config.MOCK_MODE) return false;
  await api("/api/v0/transfers/downloads/all/completed", { method: "DELETE" }).catch(() => {});
  return true;
}

export async function downloadState(id) {
  // Best-effort lookup of an active/finished download.
  const { username, filename } = decodeId(id);
  const list = await api("/api/v0/transfers/downloads").catch(() => null);
  const groups = Array.isArray(list) ? list : (list?.downloads ?? []);
  for (const g of Array.isArray(groups) ? groups : []) {
    const files = g.files ?? g.directories?.flatMap((d) => d.files ?? []) ?? [];
    const hit = (Array.isArray(files) ? files : []).find((d) => (d.filename ?? "") === filename);
    if (hit) return hit;
  }
  // Fallback: per-user queue position check also confirms the peer knows us.
  await api(
    `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(filename)}/position`
  ).catch(() => null);
  return null;
}
