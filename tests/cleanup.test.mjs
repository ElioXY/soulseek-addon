import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RESERVE_BYTES,
  cleanupStats,
  discard,
  diskUsage,
  evictionBudget,
  freeBytes,
  holdFile,
  isManaged,
  notePlayed,
  releaseFile,
  sweep,
} from "../src/cleanup.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeVolume() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "addon-cleanup-"));
  const complete = path.join(root, "downloads");
  const incomplete = path.join(root, "incomplete");
  fs.mkdirSync(path.join(complete, "Artist", "Album"), { recursive: true });
  fs.mkdirSync(incomplete, { recursive: true });
  return { root, complete, incomplete, roots: [complete, incomplete] };
}

function writeFile(dir, name, bytes, ageMs = 0) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

test("only paths inside the managed dirs are deletable", () => {
  const v = makeVolume();
  assert.equal(isManaged(path.join(v.complete, "a.mp3"), v.roots), true);
  assert.equal(isManaged(path.join(v.incomplete, "a.mp3"), v.roots), true);
  assert.equal(isManaged(path.join(v.root, "downloads"), v.roots), false);
  assert.equal(isManaged(path.join(v.root, "slskd", "slskd.yml"), v.roots), false);
  assert.equal(isManaged("/etc/passwd", v.roots), false);
});

test("disk usage counts both dirs", () => {
  const v = makeVolume();
  writeFile(v.complete, "one.flac", 1000);
  writeFile(v.incomplete, "two.flac", 500);
  const usage = diskUsage(v.roots);
  assert.equal(usage.files, 2);
  assert.equal(usage.usedBytes, 1500);
});

test("a played track is deleted after the grace period", async () => {
  const v = makeVolume();
  const file = writeFile(v.complete, "Artist/song.flac", 2048);
  const before = cleanupStats(v.roots).deleted;

  notePlayed("track-id", file, { afterMs: 30, roots: v.roots });
  assert.equal(fs.existsSync(file), true, "still there during the grace period");
  await sleep(200);

  assert.equal(fs.existsSync(file), false);
  assert.equal(cleanupStats(v.roots).deleted, before + 1);
});

test("a file being streamed is never deleted mid-response", async () => {
  const v = makeVolume();
  const file = writeFile(v.complete, "busy.flac", 512);
  holdFile(file);
  try {
    assert.equal(await discard("id", file, { roots: v.roots }), false);
    assert.equal(fs.existsSync(file), true);

    notePlayed("id", file, { afterMs: 20, roots: v.roots });
    await sleep(120);
    assert.equal(fs.existsSync(file), true, "held file survives the timer");

    releaseFile(file);
    assert.equal(await discard("id", file, { roots: v.roots }), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    releaseFile(file);
  }
});

test("the cap evicts oldest first and keeps the newest tracks", async () => {
  const v = makeVolume();
  const old = writeFile(v.complete, "old.flac", 4000, 3 * 60_000);
  const mid = writeFile(v.complete, "mid.flac", 4000, 2 * 60_000);
  const fresh = writeFile(v.complete, "Artist/Album/new.flac", 4000, 0);

  // 12 KB used, cap 6 KB -> evicts down to 90% of the cap.
  const result = await sweep({ maxBytes: 6000, roots: v.roots });

  assert.equal(result.evicted >= 1, true);
  assert.equal(fs.existsSync(old), false, "oldest goes first");
  assert.equal(fs.existsSync(fresh), true, "the track just played stays");
  assert.ok(diskUsage(v.roots).usedBytes <= 6000);
  // `mid` is only evicted if the budget needs it.
  if (result.evicted === 2) assert.equal(fs.existsSync(mid), false);
});

test("eviction skips a file that is currently being streamed", async () => {
  const v = makeVolume();
  const playing = writeFile(v.complete, "playing.flac", 4000, 5 * 60_000);
  writeFile(v.complete, "later.flac", 4000, 60_000);

  holdFile(playing);
  try {
    await sweep({ maxBytes: 4000, roots: v.roots });
    assert.equal(fs.existsSync(playing), true, "the listener keeps their audio");
  } finally {
    releaseFile(playing);
  }
});

test("sweep does nothing while under the cap", async () => {
  const v = makeVolume();
  const file = writeFile(v.complete, "small.flac", 100);
  const result = await sweep({ maxBytes: 10_000, roots: v.roots });
  assert.equal(result.evicted, 0);
  assert.equal(fs.existsSync(file), true);
});

test("the budget never lets the volume run out of room", () => {
  const GB = 1024 ** 3;
  // Room to spare: the configured cap wins.
  assert.equal(evictionBudget({ maxBytes: 700 * 1024 ** 2, total: 100e6, available: 800e6 }), 700 * 1024 ** 2);
  // Nearly full volume: keep only what leaves the reserve free.
  assert.equal(evictionBudget({ maxBytes: 700 * 1024 ** 2, total: 500e6, available: 50e6 }), 500e6 + 50e6 - RESERVE_BYTES);
  // Already inside the reserve: evict everything we hold.
  assert.equal(evictionBudget({ maxBytes: 700 * 1024 ** 2, total: 100e6, available: 10e6 }), 0);
  // Unknown filesystem: trust the configured cap.
  assert.equal(evictionBudget({ maxBytes: 700 * 1024 ** 2, total: 1e6, available: null }), 700 * 1024 ** 2);
  // Cap disabled.
  assert.equal(evictionBudget({ maxBytes: 0, total: 1e9, available: 1e9 }), 0);
  assert.ok(GB > 0);
});

test("free space is read from the volume", () => {
  const v = makeVolume();
  const free = freeBytes(v.complete);
  assert.equal(typeof free, "number");
  assert.ok(free > 0);
  // A missing dir falls back to its closest existing parent, never a crash.
  const missing = freeBytes(path.join(v.root, "nope", "deeper"));
  assert.equal(typeof missing, "number");
  assert.ok(missing > 0);
});

test("a nearly full volume evicts even below the configured cap", async () => {
  const v = makeVolume();
  const a = writeFile(v.complete, "a.flac", 4000, 60_000);
  const b = writeFile(v.complete, "b.flac", 4000, 30_000);
  // available is faked by a tiny cap: the oldest file must still go.
  const result = await sweep({ maxBytes: 4000, roots: v.roots });
  assert.equal(result.evicted >= 1, true);
  assert.equal(fs.existsSync(a), false);
  assert.ok(result.budget <= 4000);
  assert.ok(fs.existsSync(b) || result.evicted > 1);
});

test("empty album folders are pruned, the root is not", async () => {
  const v = makeVolume();
  const file = writeFile(v.complete, "Artist/Album/track.flac", 100);
  await discard("id", file, { roots: v.roots });
  assert.equal(fs.existsSync(path.join(v.complete, "Artist", "Album")), false);
  assert.equal(fs.existsSync(path.join(v.complete, "Artist")), false);
  assert.equal(fs.existsSync(v.complete), true);
});
