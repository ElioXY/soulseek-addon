import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (no dependency): KEY=value lines, # comments, no `export `.
try {
  const envFile = path.resolve(".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // .env is optional; environment wins.
}


// All runtime config comes from the environment (see .env.example).
// If SLSKD_URL + SLSKD_API_KEY are missing, the server runs in MOCK_MODE
// so you can test the BitChord contract with zero SoulSeek setup.

const PORT = Number(process.env.PORT ?? 3000);
// Empty by default: the public origin is then read from each request
// (x-forwarded-host/proto), so a deploy serves correct absolute URLs with no
// configuration. Set it only to force a canonical origin.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");

// slskd connection (headless SoulSeek daemon — no desktop app needed).
const SLSKD_URL = (process.env.SLSKD_URL ?? "").replace(/\/$/, "");
const SLSKD_API_KEY = process.env.SLSKD_API_KEY ?? "";
const MOCK_MODE = !SLSKD_URL || !SLSKD_API_KEY;

// How long to collect distributed SoulSeek search responses before answering.
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 8000);
// How long /media waits for the download's first bytes before giving up.
// /stream never waits: BitChord aborts an addon call at 20s, so the wait has to
// happen where the player is already tolerant of it. Kept under ExoPlayer's
// 8s HTTP read timeout, which is what would otherwise fail the play.
const MEDIA_WAIT_MS = Math.min(
  Number(process.env.MEDIA_WAIT_MS ?? process.env.STREAM_WAIT_MS ?? 6000) || 6000,
  8000
);

// Directory slskd downloads into. When co-deployed via docker-compose.yml this
// is the SAME shared volume, so the addon can serve the bytes at /media/:id.
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? path.resolve("downloads");
// Partial downloads live here until complete — served progressively from here too.
const INCOMPLETE_DIR = process.env.INCOMPLETE_DIR ?? path.resolve(path.dirname(DOWNLOAD_DIR), "incomplete");

// --- storage ---------------------------------------------------------------
// A track is deleted this long after the last byte was sent to a player. Every
// new request restarts the clock, so a seek or a second listener keeps the file;
// 5 minutes outlives a normal song, and the cap below is the real backstop.
// -1 keeps everything (local use).
const DELETE_AFTER_MS = Math.round(
  Number(process.env.DELETE_AFTER_MS ?? 300_000)
);
const DELETE_AFTER_MS_SAFE = Number.isFinite(DELETE_AFTER_MS) ? DELETE_AFTER_MS : 300_000;
// Hard cap for downloads + incomplete. On a 1 GiB volume leave room for slskd
// state and the image, or a full disk breaks every later transfer. The sweep
// also respects the volume's real free space, so this is an upper bound.
const MAX_STORAGE_MB = Number(process.env.MAX_STORAGE_MB ?? 700);
const MAX_STORAGE_BYTES = Number.isFinite(MAX_STORAGE_MB) && MAX_STORAGE_MB > 0
  ? Math.round(MAX_STORAGE_MB * 1024 * 1024)
  : 0;
const CLEANUP_INTERVAL_MS = Math.max(0, Number(process.env.CLEANUP_INTERVAL_MS ?? 60_000) || 0);

export const config = {
  PORT,
  PUBLIC_BASE_URL,
  SLSKD_URL,
  SLSKD_API_KEY,
  MOCK_MODE,
  SEARCH_TIMEOUT_MS,
  MEDIA_WAIT_MS,
  DOWNLOAD_DIR,
  INCOMPLETE_DIR,
  DELETE_AFTER_MS: DELETE_AFTER_MS_SAFE,
  MAX_STORAGE_BYTES,
  CLEANUP_INTERVAL_MS,
  ADDON_ID: process.env.ADDON_ID ?? "dev.soulseek.addon",
  ADDON_NAME: process.env.ADDON_NAME ?? "SoulSeek (via slskd)",
  ADDON_VERSION: process.env.ADDON_VERSION ?? "0.1.0",
};
