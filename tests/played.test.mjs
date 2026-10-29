import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// End-to-end shape of the 1 GiB rule: a full playback through /media deletes the
// track and clears its slskd record, while a seek (a range that stops short of
// the end) must not. Env before import: config.js reads it on load.
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "slskd-played-"));
const incomplete = fs.mkdtempSync(path.join(os.tmpdir(), "slskd-played-inc-"));
const removed = [];

const FILENAME = "Music\\Artist - Played Track.flac";
const PARTIAL_FILENAME = "Other\\Artist - Half Downloaded.flac";
const TRANSFER_ID = "8f1d3c7a-1111-4222-8333-944455556666";
const PARTIAL_TRANSFER_ID = "0a0b0c0d-2222-4333-8444-955566667777";
const FULL_SIZE = 8192;
const PARTIAL_TOTAL = 20000;

const fakeSlskd = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (req.method === "DELETE" && req.url.includes("/api/v0/transfers/downloads/all/completed")) {
    return send(204);
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/v0/transfers/downloads/")) {
    removed.push(req.url);
    return send(204);
  }
  if (req.url.startsWith("/api/v0/transfers/downloads")) {
    return send(200, [{
      username: "peer1",
      directories: [{
        files: [
          { id: TRANSFER_ID, filename: FILENAME, size: FULL_SIZE, state: "Completed, Succeeded" },
          // Still arriving: 4 KB of 20 KB on disk.
          { id: PARTIAL_TRANSFER_ID, filename: PARTIAL_FILENAME, size: PARTIAL_TOTAL, state: "InProgress, Downloading" },
        ],
      }],
    }]);
  }
  if (req.url.startsWith("/api/v0/server")) return send(200, { state: "Connected, LoggedIn" });
  send(200, {});
});
await new Promise((r) => fakeSlskd.listen(0, "127.0.0.1", r));

process.env.SLSKD_URL = `http://127.0.0.1:${fakeSlskd.address().port}`;
process.env.SLSKD_API_KEY = "test-key-0123456789abcdef";
process.env.DOWNLOAD_DIR = downloads;
process.env.INCOMPLETE_DIR = incomplete;
process.env.DELETE_AFTER_MS = "40";
process.env.CLEANUP_INTERVAL_MS = "0";

const { createServer } = await import("../src/server.js");
const { encodeId } = await import("../src/audio.js");

const srv = createServer();
await new Promise((r) => srv.listen(0, r));
after(() => {
  srv.close();
  fakeSlskd.close();
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.rmSync(incomplete, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${srv.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const id = encodeId("peer1", FILENAME);
const partialId = encodeId("peer1", PARTIAL_FILENAME);
// /media looks the file up by basename, which is how slskd names it on disk.
const onDisk = path.join(downloads, "Artist", "Artist - Played Track.flac");
const partialOnDisk = path.join(downloads, "Other", "Artist - Half Downloaded.flac");
function writeTrack() {
  fs.mkdirSync(path.dirname(onDisk), { recursive: true });
  fs.writeFileSync(onDisk, Buffer.alloc(FULL_SIZE, 7)); // slskd: complete (size matches)
}
function writePartial() {
  fs.mkdirSync(path.dirname(partialOnDisk), { recursive: true });
  fs.writeFileSync(partialOnDisk, Buffer.alloc(4096, 7)); // still growing to 20000
}

test("a HEAD probe never starts the delete clock", async () => {
  writeTrack();
  removed.length = 0;
  const res = await fetch(`${base}/media/${id}`, { method: "HEAD" });
  assert.equal(res.status, 200);
  await sleep(150);
  assert.equal(fs.existsSync(onDisk), true);
  assert.deepEqual(removed, []);
});

test("a download still in progress is never cached or deleted", async () => {
  writePartial();
  removed.length = 0;
  const res = await fetch(`${base}/media/${partialId}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store", "a growing file must not be immutable");

  await sleep(300);
  assert.equal(fs.existsSync(partialOnDisk), true, "slskd is still writing it");
  assert.deepEqual(removed, [], "its transfer record must survive");
});

test("a full playback deletes the track and its slskd record", async () => {
  writeTrack();
  removed.length = 0;
  const res = await fetch(`${base}/media/${id}`);
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 8192);
  assert.equal(fs.existsSync(onDisk), true, "still there during the grace period");

  await sleep(400);

  assert.equal(fs.existsSync(onDisk), false, "deleted after playback");
  assert.equal(fs.existsSync(path.dirname(onDisk)), false, "empty album folder pruned");
  assert.equal(removed.length, 1, "slskd record cleared so a replay can re-enqueue");
  assert.match(removed[0], /peer1/);
  assert.match(removed[0], new RegExp(TRANSFER_ID));
  assert.match(removed[0], /remove=true/);
});

test("health reports what is on disk", async () => {
  fs.rmSync(partialOnDisk, { force: true }); // left behind by the partial test
  writeTrack();
  const res = await fetch(`${base}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.storage.files, 1);
  assert.equal(body.storage.usedBytes, 8192);
  assert.equal(body.storage.deleteAfterMs, 40);
});
