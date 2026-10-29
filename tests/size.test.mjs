import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// slskd's QueueDownloadRequest.Size is a non-nullable long. A POST without a size
// is not "let the peer decide": the binder fills in 0, and Soulseek then aborts
// every attempt with "the remote size of N does not match expected size 0" and
// slskd retries it forever. One such record makes the track permanently
// unplayable, because every later enqueue comes back as a duplicate. The contract
// this file pins: never POST without a real size, and repair records already
// poisoned by the old "retry without a size" path.
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "slskd-size-"));
const incomplete = fs.mkdtempSync(path.join(os.tmpdir(), "slskd-size-inc-"));

const KNOWN_FILE = "Music\\Artist - Known Track.flac";
const KNOWN_SIZE = 42000000;
const MYSTERY_FILE = "Music\\Artist - Mystery Track.mp3";
const POISON_FILE = "Music\\Artist - Poisoned Track.flac";
const POISON_SIZE = 68463452;
const POISON_TRANSFER_ID = "ffffffff-1111-4222-8333-944455556666";

const fake = {
  posts: [], // { user, body }
  deletes: [],
  transfers: [], // what GET /transfers/downloads reports
  failNextPost: false, // stand-in for "slskd already holds this transfer"
  searchResponses: [],
};

const fakeSlskd = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const chunks = [];
  req.on("data", (c) => chunks.push(c));

  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    if (req.method === "POST" && req.url.startsWith("/api/v0/searches")) return send(201, { id: "s1" });
    if (/\/responses$/.test(req.url)) return send(200, fake.searchResponses);
    if (req.method === "DELETE" && req.url.startsWith("/api/v0/searches/")) return send(204);
    if (req.method === "GET" && req.url.startsWith("/api/v0/searches/")) {
      return send(200, { state: "Completed, Succeeded" });
    }
    if (req.method === "POST" && req.url.startsWith("/api/v0/transfers/downloads/")) {
      fake.posts.push({ user: decodeURIComponent(req.url.split("/").pop()), body: raw ? JSON.parse(raw) : null });
      if (fake.failNextPost) {
        fake.failNextPost = false;
        return send(500, "A download for this file already exists");
      }
      return send(201, {});
    }
    if (req.method === "DELETE" && req.url.startsWith("/api/v0/transfers/downloads/")) {
      fake.deletes.push(req.url);
      return send(204);
    }
    if (req.url.startsWith("/api/v0/transfers/downloads")) return send(200, fake.transfers);
    if (req.url.startsWith("/api/v0/server")) return send(200, { state: "Connected, LoggedIn" });
    send(200, {});
  });
});
await new Promise((r) => fakeSlskd.listen(0, "127.0.0.1", r));

process.env.SLSKD_URL = `http://127.0.0.1:${fakeSlskd.address().port}`;
process.env.SLSKD_API_KEY = "test-key-0123456789abcdef";
process.env.DOWNLOAD_DIR = downloads;
process.env.INCOMPLETE_DIR = incomplete;
process.env.SEARCH_TIMEOUT_MS = "700";
process.env.SIZE_LOOKUP_MS = "600";
process.env.CLEANUP_INTERVAL_MS = "0";

const { createServer } = await import("../src/server.js");
const { encodeId } = await import("../src/audio.js");

const srv = createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
after(() => {
  srv.close();
  fakeSlskd.close();
});
const base = `http://127.0.0.1:${srv.address().port}`;

const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = predicate();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
};

const reset = () => {
  fake.posts.length = 0;
  fake.deletes.length = 0;
  fake.transfers = [];
  fake.failNextPost = false;
  fake.searchResponses = [];
};

test("a search hit is queued with the peer's exact size, never without one", async () => {
  reset();
  fake.searchResponses = [{
    username: "peer1",
    hasFreeUploadSlot: true,
    uploadSpeed: 1000,
    queueLength: 0,
    files: [{ filename: KNOWN_FILE, size: KNOWN_SIZE }],
  }];

  const { status, body } = await get("/search?q=known%20track");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.tracks));

  const posts = await waitFor(() => (fake.posts.length > 0 ? fake.posts : null));
  assert.ok(Array.isArray(posts) && posts.length > 0, "the prefetch must queue the top hit");

  for (const post of posts) {
    assert.ok(Array.isArray(post.body), "slskd expects an array of files");
    for (const file of post.body) {
      assert.equal(typeof file.size, "number", "a request without size becomes size 0 in slskd");
      assert.equal(file.size, KNOWN_SIZE);
      assert.ok(file.size > 0);
    }
  }
});

test("an already-queued duplicate is not an error and is not deleted", async () => {
  reset();
  const id = encodeId("peer2", KNOWN_FILE);
  fake.failNextPost = true;
  fake.transfers = [{
    username: "peer2",
    directories: [{ files: [{ id: "healthy-1", filename: KNOWN_FILE, size: KNOWN_SIZE, state: "InProgress, Downloading" }] }],
  }];
  // Size has to be known before the duplicate answer arrives: a real player asks
  // /stream right after the search that produced this id.
  fake.searchResponses = [{
    username: "peer2",
    files: [{ filename: KNOWN_FILE, size: KNOWN_SIZE }],
  }];

  const res = await get(`/stream/${id}`);
  assert.equal(res.status, 200);
  await waitFor(() => fake.posts.length > 0);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(fake.deletes.length, 0, "a healthy transfer must survive");
  const { body } = await get("/health");
  assert.equal(body.lastEnqueueError, null, "already-queued is not something /health should report");
});

test("a record poisoned with size 0 is dropped and queued again with the real size", async () => {
  reset();
  const id = encodeId("peer3", POISON_FILE);
  fake.failNextPost = true; // slskd sees the dead record and rejects as duplicate
  fake.transfers = [{
    username: "peer3",
    directories: [{ files: [{ id: POISON_TRANSFER_ID, filename: POISON_FILE, size: 0, state: "Completed, Errored" }] }],
  }];
  fake.searchResponses = [{ username: "peer3", files: [{ filename: POISON_FILE, size: POISON_SIZE }] }];

  const res = await get(`/stream/${id}`);
  assert.equal(res.status, 200);

  const deleted = await waitFor(() => (fake.deletes.length > 0 ? fake.deletes : null));
  assert.ok(Array.isArray(deleted), "the dead record has to be removed");
  assert.match(deleted[0], /remove=true/);
  assert.ok(deleted[0].includes(POISON_TRANSFER_ID));

  const requeued = await waitFor(() => (fake.posts.length >= 2 ? fake.posts : null));
  assert.ok(Array.isArray(requeued) && requeued.length >= 2, "the file must be queued again");
  assert.equal(requeued[requeued.length - 1].body[0].size, POISON_SIZE);
});

test("the sweep clears dead transfer records even when the disk is fine", async () => {
  reset();
  fake.transfers = [{
    username: "peer5",
    directories: [{
      files: [
        { id: "dead-1", filename: POISON_FILE, size: 0, state: "Completed, Errored" },
        { id: "alive-1", filename: KNOWN_FILE, size: KNOWN_SIZE, state: "InProgress, Downloading" },
      ],
    }],
  }];
  const { sweep } = await import("../src/cleanup.js");
  await sweep({ maxBytes: 700 * 1024 * 1024, roots: [downloads, incomplete] });

  assert.equal(fake.deletes.filter((u) => u.includes("dead-1")).length, 1, "the dead record must go");
  assert.equal(fake.deletes.filter((u) => u.includes("alive-1")).length, 0, "an active transfer must stay");
});

test("an unknown size is refused instead of queued as a 0-byte transfer", async () => {
  reset();
  const id = encodeId("peer4", MYSTERY_FILE);

  const res = await get(`/stream/${id}`);
  assert.equal(res.status, 200, "/stream stays optimistic; the queueing is what has to be careful");
  // Let the size lookup (SIZE_LOOKUP_MS) finish and fail.
  await new Promise((r) => setTimeout(r, 1500));

  assert.equal(fake.posts.length, 0, "no POST may go out without a real size");

  const { body } = await get("/health");
  assert.match(String(body.lastEnqueueError), /size unknown/i);
});
