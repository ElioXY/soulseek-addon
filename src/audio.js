// Audio helpers: map a SoulSeek filename to honest BitChord codec metadata.
// Never overstate: unknown bitrate stays unknown, lossy stays lossy.

import fs from "node:fs";

const EXT_MAP = {
  ".flac": { codec: "flac", container: "flac", format: "flac", lossless: true },
  ".wav": { codec: "pcm", container: "wav", format: "wav", lossless: true },
  ".aiff": { codec: "pcm", container: "aiff", format: "aiff", lossless: true },
  ".alac": { codec: "alac", container: "m4a", format: "alac", lossless: true },
  ".m4a": { codec: "aac", container: "mp4", format: "aac", lossless: false },
  ".mp3": { codec: "mp3", container: "mp3", format: "mp3", lossless: false },
  ".ogg": { codec: "vorbis", container: "ogg", format: "ogg", lossless: false },
  ".oga": { codec: "vorbis", container: "ogg", format: "ogg", lossless: false },
  ".opus": { codec: "opus", container: "ogg", format: "opus", lossless: false },
  ".wma": { codec: "wma", container: "asf", format: "wma", lossless: false },
};

export const AUDIO_EXTS = new Set(Object.keys(EXT_MAP));

export function describeFile(filename, { bitrate, sampleRate, bitDepth } = {}) {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  const known = EXT_MAP[ext] ?? { codec: ext.replace(".", "") || "unknown", container: "unknown", format: "unknown", lossless: false };
  // Normalize slskd bitrate (may be kbps or bps depending on version).
  let bps;
  if (typeof bitrate === "number" && Number.isFinite(bitrate)) {
    bps = bitrate < 1000 ? Math.round(bitrate * 1000) : Math.round(bitrate);
  }
  return {
    ext,
    codec: known.codec,
    container: known.container,
    format: known.format,
    lossless: known.lossless,
    bitrate: bps,
    sampleRate: typeof sampleRate === "number" ? sampleRate : undefined,
    bitDepth: typeof bitDepth === "number" ? bitDepth : undefined,
    audioQuality: known.lossless ? "LOSSLESS" : bps && bps >= 300_000 ? "HIGH" : bps ? "STANDARD" : "UNKNOWN",
  };
}

// Real numbers for a FLAC, read from its own STREAMINFO header.
//
// The search response often carries no `sampleRate`/`bitDepth`, so a 24/96 rip
// was being reported as plain "Lossless" — and when slskd did report them the
// numbers came from the peer's claim, not from the file. 34 bytes at the start
// of the file answer both questions exactly, and reading them off a local file
// costs microseconds, so there is no reason to guess.
export function flacStreamInfo(buf) {
  if (!buf || buf.length < 42) return null;
  if (buf.subarray(0, 4).toString("latin1") !== "fLaC") return null;
  // The first metadata block must be STREAMINFO (type 0, 34-byte payload).
  const type = buf[4] & 0x7f;
  if (type !== 0) return null;
  const length = buf.readUIntBE(5, 3);
  if (length < 34) return null;
  // Payload starts at byte 8: min/max block size (2+2), min/max frame size
  // (3+3), then 8 packed bytes — sample rate (20 bits), channels-1 (3),
  // bit depth-1 (5), total samples (36).
  let bits = 0n;
  for (let i = 18; i < 26; i++) bits = (bits << 8n) | BigInt(buf[i]);
  const sampleRate = Number((bits >> 44n) & 0xfffffn);
  const channels = Number((bits >> 41n) & 0x7n) + 1;
  const bitDepth = Number((bits >> 36n) & 0x1fn) + 1;
  const totalSamples = Number(bits & 0xfffffffffn);
  if (!sampleRate || !bitDepth) return null;
  return { sampleRate, channels, bitDepth, totalSamples };
}

// Same, for a file already on disk. Null whenever it is not a readable FLAC.
export function readFlacInfo(diskPath) {
  let fd;
  try {
    fd = fs.openSync(diskPath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return flacStreamInfo(buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }
}

// Track ids must be opaque + stable + URL-safe. SoulSeek identity is (username, filename).
export function encodeId(username, filename) {
  return Buffer.from(JSON.stringify([username, filename]), "utf8").toString("base64url");
}

export function decodeId(id) {
  const [username, filename] = JSON.parse(Buffer.from(String(id), "base64url").toString("utf8"));
  if (!username || !filename) throw new Error("bad id");
  return { username, filename };
}

// "Artist - Title.mp3" or "Artist/Album/01 Title.flac" -> best-effort metadata.
// SoulSeek filenames are messy (track numbers, folders, quality tags), so this
// parses the full path, not just the basename. Accurate artist/album/duration
// is what lets BitChord pick the RIGHT recording (Title Track, not Naal Nachna).
export function guessMetadata(filename) {
  return parseSoulseekMetadata(filename);
}

const GENERIC_DIRS = new Set([
  "music", "my music", "shares", "shared", "share", "downloads", "soulseek downloads",
  "audio", "songs", "tracks", "lossless", "flac", "mp3", "mp3s", "320kbps", "320",
  "albums", "album", "singles", "single", "eps", "ep", "discography",
  "soundtrack", "soundtracks", "ost", "anime", "hindi", "punjabi", "tamil",
  "telugu", "english", "bollywood", "kpop", "jpop", "j-pop", "music videos",
]);
const QUALITY_TOKENS = /^(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff|alac|wma|320|256|192|128|v0|vinyl|web|cd|single|album|ep|lossless|hi-?res|24bit|24-96|16bit|320kbps|128kbps|cbr|vbr)$/i;

function cleanToken(s) {
  return s
    .replace(/^\[[\d.\s\-_]+\]\s*/, "") // leading "[2023.05.31]" dates
    .replace(/\s*\(\d{4}\)\s*$/, "") // trailing "(2025)" year
    .replace(/\s*\[[\d.\s\-_]+\]\s*$/, "") // trailing "[2021]" year
    .trim();
}

function stripQualityTags(s) {
  // Remove bracketed codec/bitrate tags but KEEP recording identity:
  // (feat. X), (Movie Edit), [TV Version] all stay.
  return s
    .split(/\s+/)
    .filter((w) => !/^(?:flac|mp3|m4a|aac|ogg|opus|wav|alac|wma|320|256|192|128|v0|vinyl|web|cd|lossless|hi-?res|24-?bit|16-?bit|cbr|vbr|\d{2,4}k?b?ps?)$/i.test(w.replace(/[()\[\]{}]/g, "")) || /feat/i.test(w))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim() || s.trim();
}

function isGenericDir(name) {
  const n = name.replace(/^@@/, "").trim().toLowerCase();
  return !n || n.startsWith("@@") || GENERIC_DIRS.has(n) || /^disc\s*\d+$/.test(n) || /^(cd|dvd)\d*$/i.test(n);
}

function splitArtistTitle(base) {
  // "Artist - Title" but NOT "01 - Title" (track number, not artist).
  const m = base.match(/^\s*(.+?)\s*-\s*(.+?)\s*$/);
  if (m && !/^\d{1,3}$/.test(m[1].trim())) {
    return [m[1].replace(/^\d{1,3}\s*[-.]?\s*/, "").trim() || m[1].trim(), m[2].trim()];
  }
  // Strip leading track number: "01 Title", "03. Title", "1- Title".
  const t = base.replace(/^\d{1,3}\s*[-.]?\s*/, "").trim();
  return [null, t || base.trim()];
}

export function parseSoulseekMetadata(filename) {
  const segs = filename.split(/[\\/]/);
  const rawBase = segs.pop().replace(/\.[^.]+$/, "");
  const dirs = segs.map((d) => d.trim()).filter(Boolean);

  let artist = null;
  let title = rawBase.trim();
  let album = null;

  const [dashArtist, dashTitle] = splitArtistTitle(rawBase);
  if (dashArtist) {
    artist = stripQualityTags(cleanToken(dashArtist));
    title = stripQualityTags(dashTitle);
  } else {
    title = stripQualityTags(dashTitle);
  }

  const parent = dirs.length ? cleanToken(dirs[dirs.length - 1]) : "";
  const grandparent = dirs.length > 1 ? cleanToken(dirs[dirs.length - 2]) : "";

  if (!artist) {
    // "Artist - Album" parent folder is the most reliable signal.
    const pm = parent.match(/^\s*(.+?)\s*-\s*(.+?)\s*$/);
    if (pm && !/^\d{1,3}$/.test(pm[1].trim()) && !isGenericDir(pm[1])) {
      artist = stripQualityTags(pm[1]);
      album = stripQualityTags(pm[2]);
    } else if (!isGenericDir(parent)) {
      if (/various artists/i.test(parent)) {
        artist = "Various Artists";
      } else if (grandparent && !isGenericDir(grandparent)) {
        // Artist/Album/Title folder layout.
        artist = grandparent;
        album = parent;
      } else {
        // Single folder: most likely the album ("Dhurandhar (2025)").
        album = parent;
      }
    } else if (grandparent && !isGenericDir(grandparent)) {
      artist = grandparent;
    }
  } else if (parent && !isGenericDir(parent) && !/^\d{1,3}$/.test(parent)) {
    album = parent;
  }

  return {
    artist: artist || "Unknown Artist",
    title: title || rawBase.trim(),
    album: album || undefined,
  };
}

// Rank tracks against the listener's query so the exact recording surfaces
// first — BitChord evaluates matches in the order we return.
function tokens(s) {
  return s
    .toLowerCase()
    .replace(/\bft\b\.?/g, "feat")
    .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF\u3040-\u30FF\u4E00-\u9FFF ]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

export function rankTracks(query, tracks) {
  const q = tokens(query);
  if (!q.length) return tracks;
  const qset = new Set(q);
  const scored = tracks.map((t, i) => {
    const tt = tokens(t.title ?? "");
    const at = tokens(t.artist ?? "");
    const al = tokens(t.album ?? "");
    let s = 0;
    for (const w of new Set(tt)) if (qset.has(w)) s += 2;
    if (q.every((w) => tt.includes(w))) s += 6; // full title coverage
    for (const w of new Set(at)) if (qset.has(w)) s += 2;
    for (const w of new Set(al)) if (qset.has(w)) s += 1;
    return { t, s, i };
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i); // stable: peer-speed order on ties
  return scored.map((x) => x.t);
}

// When the full query scores nothing on the distributed network, retry with
// distinctive words ("Suzume (ft. Toaka)" -> "Suzume"). Capped: each retry
// costs seconds on P2P.
export function fallbackQueries(query) {
  const words = [...new Set(tokens(query).filter((w) => w.length >= 4 && w !== "feat"))];
  const deparened = query.replace(/\s*[\(\[].*?[\)\]]\s*/g, " ").trim();
  const alts = [];
  if (deparened && deparened.toLowerCase() !== query.toLowerCase()) alts.push(deparened);
  // Longest (most distinctive) words first, max 2 extra searches.
  words.sort((a, b) => b.length - a.length);
  for (const w of words.slice(0, 2)) if (!alts.includes(w)) alts.push(w);
  return alts.filter((a) => a.toLowerCase() !== query.toLowerCase()).slice(0, 2);
}
