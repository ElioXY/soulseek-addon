// Storage hygiene for a small volume.
//
// Two independent rules, because one alone is not enough:
//   1. A track that was played through is deleted shortly after (DELETE_AFTER_MS).
//      Prefetched tracks that never get played would otherwise sit there forever.
//   2. A hard cap (MAX_STORAGE_BYTES) evicts the oldest files when the volume
//      fills up — a full disk makes slskd fail every later transfer, and the
//      listener sees a source that suddenly returns nothing.
//
// A file with an open reader is never deleted: the whole point of the volume is
// streaming the file that is currently being sent.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { removeCompletedTransfers, removeTransfer } from "./slskd.js";

const readers = new Map(); // absolute path -> open response count
const timers = new Map(); // absolute path -> pending delete timer
const knownIds = new Map(); // absolute path -> track id, so eviction can cancel it

const stats = { deleted: 0, freedBytes: 0, evicted: 0, lastSweepAt: 0, sweepInFlight: false, budgetBytes: 0 };

const defaultRoots = () => [config.DOWNLOAD_DIR, config.INCOMPLETE_DIR];

// Paths outside the managed dirs (a symlinked mount, a test directory) are never
// touched: guessing wrong here means deleting a user's file.
export function isManaged(filePath, roots = defaultRoots()) {
  const abs = path.resolve(filePath);
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), abs);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

// --- readers ---------------------------------------------------------------

export function holdFile(filePath) {
  const abs = path.resolve(filePath);
  readers.set(abs, (readers.get(abs) ?? 0) + 1);
}

export function releaseFile(filePath) {
  const abs = path.resolve(filePath);
  const next = (readers.get(abs) ?? 1) - 1;
  if (next > 0) readers.set(abs, next);
  else readers.delete(abs);
}

export const isHeld = (filePath) => readers.has(path.resolve(filePath));

// --- bookkeeping -----------------------------------------------------------

export function rememberId(id, filePath) {
  if (id) knownIds.set(path.resolve(filePath), id);
}

export function cleanupStats(roots = defaultRoots()) {
  return { ...stats, ...diskUsage(roots), freeBytes: freeBytes(roots[0]) };
}

// --- deletion --------------------------------------------------------------

// Wipes the file and its slskd record. The record matters: a completed transfer
// left in slskd's list makes the same track refuse to re-enqueue ("already
// exists"), so a replay after eviction would silently never produce a file.
export async function discard(id, filePath, { roots = defaultRoots(), force = false } = {}) {
  const abs = path.resolve(filePath);
  if (!isManaged(abs, roots)) return false;
  if (isHeld(abs) && !force) return false;

  const pending = timers.get(abs);
  if (pending) {
    clearTimeout(pending);
    timers.delete(abs);
  }

  const trackId = id ?? knownIds.get(abs);
  let freed = 0;
  try {
    freed = fs.statSync(abs).size;
  } catch {
    freed = 0;
  }
  let removed = false;
  try {
    fs.unlinkSync(abs);
    removed = true;
  } catch {
    // Already gone, or a race with slskd renaming it. Nothing to do.
  }
  if (removed) {
    stats.deleted += 1;
    stats.freedBytes += freed;
  }
  knownIds.delete(abs);
  // Best effort on both sides: the record may not exist (killed by a restart),
  // and a stale one is harmless once the file is gone.
  if (trackId) await removeTransfer(trackId).catch(() => {});
  pruneEmptyDirs(abs, roots);
  return removed;
}

// Called when a response finished serving the last byte of a complete file.
export function notePlayed(id, filePath, { afterMs = config.DELETE_AFTER_MS, roots = defaultRoots() } = {}) {
  if (afterMs < 0) return;
  const abs = path.resolve(filePath);
  if (!isManaged(abs, roots)) return;
  rememberId(id, abs);
  const existing = timers.get(abs);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(abs);
    // A seek or a second listener may still be reading; try again shortly rather
    // than leave the file behind forever.
    if (isHeld(abs)) return notePlayed(id, abs, { afterMs: 5000, roots });
    discard(id, abs, { roots }).catch(() => {});
  }, afterMs);
  timer.unref?.();
  timers.set(abs, timer);
}

// --- quota -----------------------------------------------------------------

export function diskUsage(roots = defaultRoots()) {
  let bytes = 0;
  let files = 0;
  for (const root of roots) {
    for (const f of listFiles(root)) {
      bytes += f.size;
      files += 1;
    }
  }
  return { usedBytes: bytes, files };
}

function listFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listFiles(p));
    } else if (e.isFile()) {
      try {
        const st = fs.statSync(p);
        out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Vanished between readdir and stat: slskd removed it first.
      }
    }
  }
  return out;
}

// Free bytes on the filesystem holding the downloads, or null when unknown.
export function freeBytes(dir) {
  // The directory may not exist yet (mock mode, first boot): ask the closest
  // existing parent, which lives on the same filesystem.
  let target = path.resolve(dir);
  for (;;) {
    try {
      const s = fs.statfsSync(target);
      const free = Number(s.bavail) * Number(s.bsize);
      return Number.isFinite(free) ? free : null;
    } catch {
      const parent = path.dirname(target);
      if (parent === target) return null;
      target = parent;
    }
  }
}

// How much we may keep: the configured cap, but never so much that the volume
// runs out of room. A 1 GiB volume with an 850 MB cap fills up the moment the
// platform's own files grow, and a full disk stops slskd from writing anything
// at all — the failure mode reserved space prevents.
export const RESERVE_BYTES = 128 * 1024 * 1024;

export function evictionBudget({ maxBytes, total, available }) {
  if (!maxBytes) return 0;
  if (available === null || available === undefined) return maxBytes;
  return Math.max(0, Math.min(maxBytes, total + available - RESERVE_BYTES));
}

// Evicts oldest-first until the volume is back under the cap (with headroom, so
// the next few downloads fit before another sweep).
export async function sweep({ maxBytes = config.MAX_STORAGE_BYTES, roots = defaultRoots() } = {}) {
  stats.lastSweepAt = Date.now();
  const files = roots.flatMap((root) => listFiles(root));
  let total = files.reduce((sum, f) => sum + f.size, 0);
  const available = freeBytes(roots[0]);
  const budget = evictionBudget({ maxBytes, total, available });
  stats.budgetBytes = budget;
  if (!maxBytes || total <= budget) return { total, evicted: 0, budget };

  const target = Math.floor(budget * 0.9);
  let evicted = 0;
  const oldestFirst = files
    .filter((f) => !isHeld(f.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of oldestFirst) {
    if (total <= target) break;
    if (await discard(knownIds.get(f.path), f.path, { roots, force: true })) {
      total -= f.size;
      evicted += 1;
      stats.evicted += 1;
    }
  }
  // Completed records for files we never tracked (a restart, a manual delete)
  // would otherwise pile up in slskd and refuse later re-enqueues.
  await removeCompletedTransfers().catch(() => {});
  return { total, evicted, budget };
}

// --- scheduler -------------------------------------------------------------

let interval = null;

export function startCleanup() {
  if (interval) return interval;
  const every = config.CLEANUP_INTERVAL_MS;
  if (every <= 0) return null;
  interval = setInterval(() => {
    if (stats.sweepInFlight) return;
    stats.sweepInFlight = true;
    sweep()
      .catch((err) => console.error("cleanup sweep failed:", err.message))
      .finally(() => {
        stats.sweepInFlight = false;
      });
  }, every);
  interval.unref?.();
  // The first check happens right away: after a restart the volume may already be
  // full, and the platform restarts the container when it fills up again.
  stats.sweepInFlight = true;
  sweep()
    .catch(() => {})
    .finally(() => {
      stats.sweepInFlight = false;
    });
  return interval;
}

export function stopCleanup() {
  if (interval) clearInterval(interval);
  interval = null;
}

function pruneEmptyDirs(filePath, roots) {
  let dir = path.dirname(path.resolve(filePath));
  const stop = roots.map((r) => path.resolve(r));
  while (!stop.includes(dir)) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
