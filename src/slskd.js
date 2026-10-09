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
  // Fast peers first: free upload slot, higher speed, shorter queue —
  // then audio quality. A queued peer can stall /stream for minutes.
  return out.sort((a, b) =>
    (b._freeSlot - a._freeSlot) ||
    (b._speed - a._speed) ||
    (a._queue - b._queue) ||
    ((a.audioQuality === "LOSSLESS" ? 0 : 1) - (b.audioQuality === "LOSSLESS" ? 0 : 1))
  );
}

export async function enqueueDownload(id, size) {
  // slskd >= 0.25: POST /api/v0/transfers/downloads/{username} [{ filename, size }]
  // (verified against the 0.26 web UI bundle; older /api/v0/downloads is gone).
  // Size must be exact — slskd aborts when it mismatches the peer's report.
  const { username, filename } = decodeId(id);
  if (typeof size !== "number") size = await resolveSize(username, filename);
  const file = { filename };
  if (typeof size === "number") file.size = size;
  return api(`/api/v0/transfers/downloads/${encodeURIComponent(username)}`, {
    method: "POST",
    body: [file],
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
    await sleep(6500);
    const responses = (await api(`/api/v0/searches/${encodeURIComponent(sid)}/responses`).catch(() => [])) ?? [];
    for (const r of Array.isArray(responses) ? responses : []) {
      if ((r.username ?? r.user) !== username) continue;
      for (const f of r.files ?? r.fileList ?? []) {
        if ((f.filename ?? f.path) === filename && typeof f.size === "number") return f.size;
      }
    }
  } finally {
    api(`/api/v0/searches/${encodeURIComponent(sid)}`, { method: "DELETE" }).catch(() => {});
  }
  return undefined;
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
