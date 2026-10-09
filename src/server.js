// BitChord addon server: GET /manifest.json, GET /search, GET /stream/:id, GET /media/:id.
// Zero dependencies (node:http + node:fs only). `node src/server.js` to run.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { searchMock, streamMock } from "./mock.js";
import { decodeId, describeFile, rankTracks, fallbackQueries } from "./audio.js";
import { downloadState, enqueueDownload, searchSoulseek } from "./slskd.js";

const searchCache = new Map(); // q -> { at, tracks } (BitChord caches ~10 min)
const streamCache = new Map(); // id -> { at, body } (BitChord caches ~5 min)
const SEARCH_TTL = 10 * 60 * 1000;
const STREAM_TTL = 5 * 60 * 1000;

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
};

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
        enqueueDownload(t.id, t._size).catch(() => {});
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

async function handleStream(id, res) {
  const hit = streamCache.get(id);
  if (hit && Date.now() - hit.at < STREAM_TTL) return json(res, 200, hit.body);

  if (config.MOCK_MODE) {
    const body = streamMock(id);
    if (!body) return json(res, 404, { error: "not in this addon" });
    streamCache.set(id, { at: Date.now(), body });
    return json(res, 200, body);
  }

  // Real mode: ask the peer to send the file, wait for first bytes on disk.
  try {
    const meta0 = findCachedMeta(id);
    // Enqueue best-effort: slskd 500s when the file is already downloaded/queued,
    // in which case we just serve what's on disk below.
    await enqueueDownload(id, meta0?.size).catch((e) => console.error("enqueue note:", e.message));
    const file = await waitForFile(id);
    if (!file) return json(res, 404, { error: "peer unavailable or queued — try next source" });
    const meta = describeFile(file.filename);
    const body = {
      url: `${config.PUBLIC_BASE_URL}/media/${encodeURIComponent(id)}`,
      format: meta.format,
      quality: meta.lossless
        ? (meta0?.bitDepth && meta0.bitDepth > 16
          ? `Lossless · Hi-Res ${meta0.bitDepth}-bit${meta0.sampleRate ? ` / ${(meta0.sampleRate / 1000).toFixed(1)} kHz` : ""} (SoulSeek)`
          : "Lossless (SoulSeek)")
        : meta.bitrate ? `SoulSeek · ~${Math.round(meta.bitrate / 1000)} kbps` : "SoulSeek",
      codec: meta.codec,
      container: meta.container,
      manifest: "none",
      encrypted: false,
      ...(meta.bitrate ? { bitrate: meta.bitrate } : {}),
      ...(meta0?.sampleRate ? { sampleRate: meta0.sampleRate } : {}),
      ...(meta0?.bitDepth ? { bitDepth: meta0.bitDepth } : {}),
    };
    streamCache.set(id, { at: Date.now(), body });
    json(res, 200, body);
  } catch (err) {
    console.error("stream failed:", err.message);
    json(res, 404, { error: "not in this addon" });
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
      };
    }
  }
  return {};
}

// Poll the shared download dir until the file appears with content.
// Prefers the COMPLETE file (players choke on truncated audio); falls back
// to a partial file at timeout so BitChord can at least try the next source.
async function waitForFile(id) {
  const { filename } = decodeId(id);
  const base = filename.split(/[\\/]/).pop();
  const deadline = Date.now() + config.STREAM_WAIT_MS;
  while (Date.now() < deadline) {
    const hit = findOnDisk(base);
    if (hit) {
      const expected = (await downloadState(id).catch(() => null))?.size;
      if (!expected || fs.statSync(hit).size >= expected) return { filename, diskPath: hit };
    } else {
      await downloadState(id).catch(() => null); // keep slskd polling warm
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const hit = findOnDisk(base);
  return hit ? { filename, diskPath: hit } : null;
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
  const diskPath = findOnDisk(filename.split(/[\\/]/).pop());
  if (!diskPath) return json(res, 404, { error: "file not downloaded yet" });

  const headOnly = req.method === "HEAD";
  let stat;
  try {
    stat = fs.statSync(diskPath);
  } catch {
    return json(res, 404, { error: "file not downloaded yet" });
  }
  const cache = await mediaCacheControl(id, diskPath, stat.size);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType(diskPath),
      "Cache-Control": cache,
    });
    if (headOnly) return res.end();
    fs.createReadStream(diskPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Content-Type": contentType(diskPath),
      "Cache-Control": cache,
    });
    if (headOnly) return res.end();
    fs.createReadStream(diskPath).pipe(res);
  }
}

// Edge-cache policy (cf-edge-cache): a COMPLETE file is immutable per id, so
// CDNs may cache it long-term. A partial download must NEVER be cached —
// that would poison the edge with truncated audio.
export function cacheControlFor(diskSize, expectedSize) {
  if (typeof expectedSize === "number" && expectedSize > 0 && diskSize >= expectedSize) {
    return "public, max-age=31536000, immutable";
  }
  return "no-store";
}

function isUnderDir(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function mediaCacheControl(id, diskPath, diskSize) {
  // Completed downloads live directly under DOWNLOAD_DIR -> immutable, no
  // slskd round-trip needed on every (frequent) range request.
  if (!isUnderDir(config.INCOMPLETE_DIR, diskPath)) {
    return "public, max-age=31536000, immutable";
  }
  const expected = (await downloadState(id).catch(() => null))?.size;
  return cacheControlFor(diskSize, expected);
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
    if (req.method === "GET" && url.pathname === "/manifest.json") return json(res, 200, manifest());
    if (req.method === "GET" && url.pathname === "/search") return handleSearch(url, res);
    if (req.method === "GET" && url.pathname.startsWith("/stream/")) {
      return handleStream(decodeURIComponent(url.pathname.slice(8)), res);
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/media/")) {
      return handleMedia(decodeURIComponent(url.pathname.slice(7)), req, res);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, mock: config.MOCK_MODE });
    }
    return json(res, 404, { error: "not found" });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(config.PORT, () => {
    console.log(`soulseek-addon on :${config.PORT} (${config.MOCK_MODE ? "MOCK mode — set SLSKD_URL + SLSKD_API_KEY for real SoulSeek" : "slskd connected"})`);
  });
}
