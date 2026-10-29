// BitChord addon server: GET /manifest.json, GET /search, GET /stream/:id, GET /media/:id.
// Zero dependencies (node:http + node:fs only). `node src/server.js` to run.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { searchMock, streamMock } from "./mock.js";
import { decodeId, describeFile, rankTracks, fallbackQueries, readFlacInfo } from "./audio.js";
import { downloadState, enqueueDownload, isDeadTransfer, removeTransfer, searchSoulseek } from "./slskd.js";
import { cleanupStats, holdFile, notePlayed, releaseFile, startCleanup } from "./cleanup.js";

const searchCache = new Map(); // q -> { at, tracks } (BitChord caches ~10 min)
const streamCache = new Map(); // id -> { at, body } (BitChord caches ~5 min)
const SEARCH_TTL = 10 * 60 * 1000;
const STREAM_TTL = 5 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
};

// Public origin of this deployment. `PUBLIC_BASE_URL` wins when set; otherwise
// it is taken from the request the client just made (proxy headers included),
// so a fresh deployment serves correct absolute URLs with zero configuration.
export function resolveBaseUrl(headers = {}, configured = config.PUBLIC_BASE_URL) {
  if (configured) return configured.replace(/\/+$/, "");
  const first = (value) => String(value ?? "").split(",")[0].trim();
  const host = first(headers["x-forwarded-host"] || headers.host) || `localhost:${config.PORT}`;
  const proto = first(headers["x-forwarded-proto"])
    || (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

// A playable body always points at our own /media/:id (Range-capable). The URL
// is attached per request, never cached, so a host change cannot pin old URLs.
function withMediaUrl(body, id, req) {
  return { ...body, url: `${resolveBaseUrl(req?.headers)}/media/${encodeURIComponent(id)}` };
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

// Landing page: what is deployed, in which mode, and the URLs to paste into
// BitChord. Handy right after a deploy — no logs, no guessing.
function statusPage(req) {
  const base = resolveBaseUrl(req?.headers);
  const mode = config.MOCK_MODE ? "mock" : "slskd";
  const manifestUrl = `${base}/manifest.json`;
  const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.ADDON_NAME)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 44rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  p.lead { margin: 0 0 1.5rem; opacity: .75; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid rgba(127,127,127,.3); vertical-align: top; }
  th { width: 9rem; font-weight: 600; opacity: .75; }
  code, a { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .badge { font: 600 .75rem/1 system-ui, sans-serif; padding: .3rem .5rem; border-radius: 999px; background: rgba(127,127,127,.18); }
  footer { opacity: .6; font-size: .85rem; }
</style></head>
<body>
  <h1>${escapeHtml(config.ADDON_NAME)}</h1>
  <p class="lead">BitChord addon for the SoulSeek network. <span class="badge">${mode} mode</span></p>
  <table>
    ${row("Manifest", `<a href="/manifest.json">${escapeHtml(manifestUrl)}</a>`)}
    ${row("Addon id", `<code>${escapeHtml(config.ADDON_ID)}</code> v${escapeHtml(config.ADDON_VERSION)}`)}
    ${row("Health", `<a href="/health">${escapeHtml(base)}/health</a>`)}
    ${row("Try a search", `<a href="/search?q=midnight">${escapeHtml(base)}/search?q=midnight</a>`)}
    ${row("slskd", config.MOCK_MODE ? "not configured — serving the mock catalogue" : `connected at <code>${escapeHtml(config.SLSKD_URL)}</code>`)}
  </table>
  <p>Paste the manifest URL in <strong>BitChord → Settings → Sources</strong>.</p>
  <footer>Mock mode returns fixture tracks and public sample audio; set <code>SLSKD_URL</code> + <code>SLSKD_API_KEY</code> for real SoulSeek results.</footer>
</body></html>`;
}

function sendStatus(req, res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(statusPage(req));
}

function manifest() {
  return {
    id: config.ADDON_ID,
    name: `${config.ADDON_NAME}${config.MOCK_MODE ? " (mock — slskd not connected)" : ""}`,
    version: config.ADDON_VERSION,
    resources: ["search", "stream"],
    allowDownloads: 1,
    checkValidLossless: 0,
    settings: [{ key: "quality", type: "select", default: "lossless" }],
  };
}

async function handleSearch(url, res) {
  const q = url.searchParams.get("q") ?? "";
  const hit = searchCache.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < SEARCH_TTL) return json(res, 200, { tracks: hit.tracks });

  try {
    let tracks = config.MOCK_MODE ? searchMock(q) : await searchSoulseek(q);
    // Empty on P2P often means the phrasing missed, not that nothing exists —
    // retry distinctive words before giving up (capped: each costs seconds).
    if (!config.MOCK_MODE && tracks.length === 0) {
      const seen = new Set();
      for (const alt of fallbackQueries(q)) {
        const more = await searchSoulseek(alt, { timeoutMs: 6000 }).catch(() => []);
        for (const t of more) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            tracks.push(t);
          }
        }
        if (tracks.length >= 8) break;
      }
    }
    // Exact recording first: BitChord evaluates matches in our order.
    tracks = rankTracks(q, tracks).slice(0, 20);
    // Cache hits only (full rows incl. internals for /stream fidelity lookup).
    if (tracks.length > 0) searchCache.set(q.toLowerCase(), { at: Date.now(), tracks });
    // Strip internal (_-prefixed) fields before responding.
    const pub = tracks.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith("_"))));
    json(res, 200, { tracks: pub });
    // Prefetch: BitChord usually plays one of the top hits next. Start those
    // downloads NOW in the background so /stream resolves in seconds.
    if (!config.MOCK_MODE) {
      const PREFETCH_N = Number(process.env.PREFETCH_N ?? 3);
      for (const t of tracks.slice(0, PREFETCH_N)) {
        startDownload(t.id, t._size).catch(() => {});
      }
    }
  } catch (err) {
    console.error("search failed:", err.message);
    // Pass through rate-limiting so BitChord backs off instead of caching a miss.
    if (/-> 429\b/.test(err.message)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      return res.end(JSON.stringify({ tracks: [], error: "soulseek search throttled, retry shortly" }));
    }
    // Fail soft: empty results let BitChord try the next source.
    json(res, 200, { tracks: [] });
  }
}

// /stream must never wait for SoulSeek: BitChord's addon client aborts a call at
// 20s (AddonClient.callTimeout), and a queued peer can take minutes. Waiting here
// is what made every stream miss and fall back to YouTube — the lossless copy was
// on disk, the answer arrived too late.
//
// Optimistic by design: enqueue, answer with the /media URL, and let /media wait
// for the first bytes. An enqueue that fails is not a miss — slskd 500s whenever
// it already holds the transfer, which is the normal state for a prefetched id.

async function handleStream(id, req, res) {
  const hit = streamCache.get(id);
  if (hit && Date.now() - hit.at < STREAM_TTL) {
    return json(res, 200, config.MOCK_MODE ? hit.body : withMediaUrl(hit.body, id, req));
  }

  if (config.MOCK_MODE) {
    const body = streamMock(id);
    if (!body) return json(res, 404, { error: "not in this addon" });
    streamCache.set(id, { at: Date.now(), body });
    return json(res, 200, body);
  }

  let filename;
  try {
    ({ filename } = decodeId(id));
  } catch {
    return json(res, 404, { error: "bad id" });
  }

  const meta0 = findCachedMeta(id);
  // Prefetched or replayed: the bytes are already here, so answer without
  // touching slskd at all. This is the common path for the top search hits.
  const diskPath = findOnDisk(baseName(filename));
  if (!diskPath) {
    startDownload(id, meta0.size).catch((e) => console.error("enqueue note:", e.message));
  }

  // Read the real numbers off the FLAC header so a 24/96 rip is labelled as such
  // instead of "Lossless".
  const meta = describeFile(filename);
  const probe = meta.lossless && diskPath ? readFlacInfo(diskPath) : null;
  const sampleRate = probe?.sampleRate ?? meta0.sampleRate;
  const bitDepth = probe?.bitDepth ?? meta0.bitDepth;
  const bitrate = meta0.bitrate ?? meta.bitrate;

  const body = {
    format: meta.format,
    quality: meta.lossless
      ? (bitDepth && bitDepth > 16
        ? `Lossless · Hi-Res ${bitDepth}-bit${sampleRate ? ` / ${(sampleRate / 1000).toFixed(1)} kHz` : ""} (SoulSeek)`
        : "Lossless (SoulSeek)")
      : bitrate ? `SoulSeek · ~${Math.round(bitrate / 1000)} kbps` : "SoulSeek",
    codec: meta.codec,
    container: meta.container,
    manifest: "none",
    encrypted: false,
    ...(bitrate ? { bitrate } : {}),
    ...(sampleRate ? { sampleRate } : {}),
    ...(bitDepth ? { bitDepth } : {}),
  };
  // Only cache what was answered from the bytes themselves: a body built before
  // the download started carries no bit depth, and a later replay deserves the
  // Hi-Res label the file can now prove.
  if (diskPath) streamCache.set(id, { at: Date.now(), body });
  json(res, 200, withMediaUrl(body, id, req));
}

// One enqueue per id: slskd 500s when the file is already queued or downloaded,
// and a prefetched id is asked for again by /stream a second later.
const started = new Map(); // id -> Promise
// The last refusal from slskd, for /health. A transfer that never starts looks
// identical to a peer that never answers, and only this message tells them apart.
let lastEnqueueError = null;
function startDownload(id, size) {
  const pending = started.get(id);
  if (pending) return pending;
  const p = enqueueWithRecovery(id, size).catch((err) => {
    lastEnqueueError = String(err.message ?? err).slice(0, 200);
    throw err;
  });
  started.set(id, p);
  // A failure must not be remembered: the next request deserves a fresh attempt.
  p.catch(() => started.delete(id));
  if (started.size > 512) started.delete(started.keys().next().value);
  return p;
}

// A dead record (see isDeadTransfer) makes the track unplayable until it is gone:
// the repair is to drop it and queue the file again with a real size.
async function enqueueWithRecovery(id, size) {
  try {
    return await enqueueDownload(id, size);
  } catch (err) {
    // slskd 500s whenever it already holds the transfer, which is the normal
    // answer for a prefetched id — not a miss, and not an error worth showing.
    const state = await downloadState(id).catch(() => null);
    if (!state) throw err;
    if (!isDeadTransfer(state)) return state;
    await removeTransfer(id, state).catch(() => {});
    return enqueueDownload(id, size);
  }
}

// Size + fidelity as reported by the search response, if this id came from a cached search.
function findCachedMeta(id) {
  for (const { tracks } of searchCache.values()) {
    const hit = tracks.find((t) => t.id === id);
    if (hit) {
      return {
        size: typeof hit._size === "number" ? hit._size : undefined,
        sampleRate: typeof hit._sampleRate === "number" ? hit._sampleRate : undefined,
        bitDepth: typeof hit._bitDepth === "number" ? hit._bitDepth : undefined,
        bitrate: typeof hit._bitrate === "number" ? hit._bitrate : undefined,
      };
    }
  }
  return {};
}

const baseName = (filename) => filename.split(/[\\/]/).pop();

// Poll the shared download dir until the file appears with content.
// Used by /media, which is where the player's patience belongs: it opens this URL
// right after /stream answered, and SoulSeek still has to connect and start.
async function waitForBytes(id, waitMs) {
  const { filename } = decodeId(id);
  const base = baseName(filename);
  const deadline = Date.now() + waitMs;
  let lastStateCheck = 0;
  while (Date.now() < deadline) {
    const hit = findOnDisk(base);
    if (hit) return hit;
    // A transfer that has already failed will never produce a file; stop early
    // instead of holding the player's connection open for the full wait.
    if (Date.now() - lastStateCheck > 1000) {
      lastStateCheck = Date.now();
      const state = await downloadState(id).catch(() => null);
      if (/error|abort|cancel|fail|timedout/i.test(String(state?.state ?? ""))) return null;
    }
    await sleep(250);
  }
  return findOnDisk(base);
}

function findOnDisk(basename) {
  for (const root of [config.DOWNLOAD_DIR, config.INCOMPLETE_DIR]) {
    const hit = walk(root, basename);
    if (hit) return hit;
  }
  return null;
}

function walk(dir, basename) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === basename && fs.statSync(p).size > 0) return p;
    if (e.isDirectory()) {
      const hit = walk(p, basename);
      if (hit) return hit;
    }
  }
  return null;
}

async function handleMedia(id, req, res) {
  if (config.MOCK_MODE) return json(res, 404, { error: "mock mode has no local media" });
  let filename;
  try {
    filename = decodeId(id).filename;
  } catch {
    return json(res, 404, { error: "bad id" });
  }
  let diskPath = findOnDisk(baseName(filename));
  if (!diskPath) {
    // A restart forgets the queue, and a retried play arrives here directly.
    // Ask for the transfer again (background: cold sizes need a search) and give
    // the player a bounded wait instead of an instant miss.
    startDownload(id, findCachedMeta(id).size).catch(() => {});
    diskPath = await waitForBytes(id, config.MEDIA_WAIT_MS);
  }
  if (!diskPath) return json(res, 404, { error: "file not downloaded yet" });

  const headOnly = req.method === "HEAD";
  let stat;
  try {
    stat = fs.statSync(diskPath);
  } catch {
    return json(res, 404, { error: "file not downloaded yet" });
  }
  // Whether these bytes are the whole track decides two things: a partial file
  // must never be advertised as immutable (that poisons caches with truncated
  // audio forever) and must never be deleted out from under slskd.
  const done = await completeness(id, diskPath, stat.size);
  const cache = done.complete ? IMMUTABLE : "no-store";
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m?.[1] ? Number(m[1]) : 0;
    // Clamp to what is on disk: a player asking for more than a still-growing
    // partial file holds would otherwise be promised bytes that never come, and
    // it sees a truncated read instead of the short range it asked past.
    const end = Math.min(m?.[2] ? Number(m[2]) : stat.size - 1, stat.size - 1);
    if (start >= stat.size || end < start) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType(diskPath),
      "Cache-Control": cache,
    });
    if (headOnly) return res.end();
    return serveFile(id, diskPath, res, done.complete, () =>
      fs.createReadStream(diskPath, { start, end })
    );
  }
  res.writeHead(200, {
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Content-Type": contentType(diskPath),
    "Cache-Control": cache,
  });
  if (headOnly) return res.end();
  return serveFile(id, diskPath, res, done.complete, () => fs.createReadStream(diskPath));
}

// Pipes the file. The path stays marked as held while the response is open, so
// cleanup never unlinks a file mid-stream, and every served response restarts
// the delete clock: a seek or a second listener is activity, not a reason to
// lose the audio. Only complete downloads are scheduled — a partial file is
// still being written by slskd.
function serveFile(id, diskPath, res, complete, open) {
  holdFile(diskPath);
  res.on("close", () => releaseFile(diskPath));
  if (complete) res.on("finish", () => notePlayed(id, diskPath));
  const stream = open();
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// Edge-cache policy (cf-edge-cache): a COMPLETE file is immutable per id, so
// CDNs may cache it long-term. A partial download must NEVER be cached —
// that would poison the edge with truncated audio.
const IMMUTABLE = "public, max-age=31536000, immutable";

export function cacheControlFor(diskSize, expectedSize) {
  if (typeof expectedSize === "number" && expectedSize > 0 && diskSize >= expectedSize) {
    return IMMUTABLE;
  }
  return "no-store";
}

function isUnderDir(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Is this file the whole track, or a download still being written?
//
// The directory is not a reliable answer: slskd 0.2x writes the target file
// straight into the downloads dir while it grows, so a 13 KB "complete" FLAC was
// being served as a finished track (and cached as immutable) a second after the
// transfer started. Size is the honest signal: compare what is on disk with the
// expected total from the search result or from slskd's own transfer record.
// id -> size that was already proven whole. Keyed by size, not just id, so a
// re-download of the same track (after cleanup deleted it) starts over instead
// of trusting the old answer.
const provenComplete = new Map();

function rememberComplete(id, size) {
  provenComplete.set(id, size);
  if (provenComplete.size > 512) provenComplete.delete(provenComplete.keys().next().value);
  return { complete: true };
}

async function completeness(id, diskPath, diskSize) {
  const proven = provenComplete.get(id);
  if (typeof proven === "number" && diskSize >= proven) return { complete: true };
  const cached = findCachedMeta(id);
  let expected = typeof cached.size === "number" && cached.size > 0 ? cached.size : undefined;
  let state = null;
  if (!expected) {
    state = await downloadState(id).catch(() => null);
    if (typeof state?.size === "number" && state.size > 0) expected = state.size;
  }
  if (expected) {
    if (diskSize >= expected) return { ...rememberComplete(id, diskSize), expected };
    return { complete: false, expected };
  }
  if (/completed/i.test(String(state?.state ?? ""))) return rememberComplete(id, diskSize);
  // No record and no size to compare: a file that is not growing is settled.
  // slskd writes continuously, so a second look 400ms later is enough.
  try {
    const before = fs.statSync(diskPath).size;
    await sleep(400);
    if (fs.statSync(diskPath).size === before) return rememberComplete(id, before);
  } catch {
    // Vanished mid-check: slskd renamed it after finishing.
    return { complete: false };
  }
  return { complete: false };
}

// Players sniff format by MIME first; extensionless /media/:id URLs need this.
function contentType(diskPath) {
  const ext = diskPath.slice(diskPath.lastIndexOf(".")).toLowerCase();
  if (ext === ".flac") return "audio/flac";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg" || ext === ".oga" || ext === ".opus") return "audio/ogg";
  if (ext === ".wav") return "audio/wav";
  return "application/octet-stream";
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") return sendStatus(req, res);
    if (req.method === "GET" && url.pathname === "/manifest.json") return json(res, 200, manifest());
    if (req.method === "GET" && url.pathname === "/search") return handleSearch(url, res);
    if (req.method === "GET" && url.pathname.startsWith("/stream/")) {
      return handleStream(decodeURIComponent(url.pathname.slice(8)), req, res);
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/media/")) {
      return handleMedia(decodeURIComponent(url.pathname.slice(7)), req, res);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return slskdHealth().then((slskd) => json(res, 200, {
        ok: true,
        mock: config.MOCK_MODE,
        mode: config.MOCK_MODE ? "mock" : "slskd",
        version: config.ADDON_VERSION,
        uptime: Math.round(process.uptime()),
        slskd,
        lastEnqueueError,
        storage: {
          ...cleanupStats(),
          deleteAfterMs: config.DELETE_AFTER_MS,
          maxBytes: config.MAX_STORAGE_BYTES,
        },
      }));
    }
    return json(res, 404, { error: "not found" });
  });
}

// "The addon is up" and "SoulSeek is reachable" are different facts, and only the
// second one explains empty searches. Asked with a short timeout so a wedged
// slskd cannot make the platform's own health check time out.
async function slskdHealth() {
  if (config.MOCK_MODE) return { configured: false };
  const headers = { "X-API-Key": config.SLSKD_API_KEY };
  const timeout = { signal: AbortSignal.timeout(1200) };
  try {
    const res = await fetch(`${config.SLSKD_URL}/api/v0/application`, { headers, ...timeout });
    if (!res.ok) return { configured: true, reachable: false, status: res.status };
    // An empty search is either "nobody has it" or "slskd is not logged in", and
    // only Soulseek's own state tells them apart: it reads "Connected, LoggedIn"
    // on a live session and drops LoggedIn when another client takes the name.
    const server = await fetch(`${config.SLSKD_URL}/api/v0/server`, { headers, ...timeout })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    return {
      configured: true,
      reachable: true,
      status: 200,
      state: server?.state ?? null,
      loggedIn: /loggedin/i.test(String(server?.state ?? "")),
    };
  } catch {
    return { configured: true, reachable: false };
  }
}

// pathToFileURL keeps the "run this file directly" check working on Windows,
// where a C:\ path never equals a naive file:// string.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCleanup();
  createServer().listen(config.PORT, () => {
    console.log(`soulseek-addon on :${config.PORT} (${config.MOCK_MODE ? "MOCK mode — set SLSKD_URL + SLSKD_API_KEY for real SoulSeek" : "slskd connected"})`);
  });
}
