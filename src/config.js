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
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

// slskd connection (headless SoulSeek daemon — no desktop app needed).
const SLSKD_URL = (process.env.SLSKD_URL ?? "").replace(/\/$/, "");
const SLSKD_API_KEY = process.env.SLSKD_API_KEY ?? "";
const MOCK_MODE = !SLSKD_URL || !SLSKD_API_KEY;

// How long to collect distributed SoulSeek search responses before answering.
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 8000);
// How long /stream waits for the download's first bytes before giving up (404 -> next source).
const STREAM_WAIT_MS = Number(process.env.STREAM_WAIT_MS ?? 20000);

// Directory slskd downloads into. When co-deployed via docker-compose.yml this
// is the SAME shared volume, so the addon can serve the bytes at /media/:id.
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? path.resolve("downloads");
// Partial downloads live here until complete — served progressively from here too.
const INCOMPLETE_DIR = process.env.INCOMPLETE_DIR ?? path.resolve(path.dirname(DOWNLOAD_DIR), "incomplete");

export const config = {
  PORT,
  PUBLIC_BASE_URL,
  SLSKD_URL,
  SLSKD_API_KEY,
  MOCK_MODE,
  SEARCH_TIMEOUT_MS,
  STREAM_WAIT_MS,
  DOWNLOAD_DIR,
  INCOMPLETE_DIR,
  ADDON_ID: process.env.ADDON_ID ?? "dev.soulseek.addon",
  ADDON_NAME: process.env.ADDON_NAME ?? "SoulSeek (via slskd)",
  ADDON_VERSION: process.env.ADDON_VERSION ?? "0.1.0",
};
