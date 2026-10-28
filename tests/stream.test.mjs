import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// BitChord aborts an addon call at 20s. /stream used to sit on the SoulSeek queue
// for exactly that long, so every play timed out and fell back to YouTube — the
// bug this file pins. The contract now: /stream answers at once, /media waits.
//
// Env is set before importing the server, because config.js reads it on import.
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "slskd-dl-"));
const incomplete = fs.mkdtempSync(path.join(os.tmpdir(), "slskd-incomplete-"));

// A FLAC header with real STREAMINFO numbers, so the 24/96 label is checked
// against the file rather than against anything the test told the server.
function flacHeader({ sampleRate, bitDepth, channels = 2, totalSamples = 0 }) {
  const header = Buffer.alloc(42);
  header.write("fLaC", 0, "latin1");
  header[4] = 0x80; // last metadata block, type 0 = STREAMINFO
  header.writeUIntBE(34, 5, 3);
  const packed = (BigInt(sampleRate) << 44n)
    | (BigInt(channels - 1) << 41n)
    | (BigInt(bitDepth - 1) << 36n)
    | BigInt(totalSamples);
  for (let i = 0; i < 8; i++) {
    header[18 + i] = Number((packed >> BigInt((7 - i) * 8)) & 0xffn);
  }
  return Buffer.concat([header, Buffer.alloc(4096)]);
}

// Stand-in slskd: accepts searches and transfers, never sends a byte.
const fakeSlskd = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (req.method === "POST" && req.url.startsWith("/api/v0/searches")) return send(201, { id: "s1" });
  if (/\/responses$/.test(req.url)) {
    return send(200, [{
      username: "peer1",
      hasFreeUploadSlot: true,
      uploadSpeed: 1000,
      queueLength: 0,
      files: [{ filename: "Music\\Artist - Track.flac", size: 42000000 }],
    }]);
  }
  if (req.url.startsWith("/api/v0/searches/")) return send(200, { state: "Completed, Succeeded" });
  // slskd answers 500 whenever it already holds the transfer; peer500 stands in
  // for that so the optimistic path is covered.
  if (req.method === "POST" && req.url.startsWith("/api/v0/transfers/downloads/")) {
    return req.url.includes("peer500") ? send(500) : send(201);
  }
  if (req.url.startsWith("/api/v0/transfers/downloads")) return send(200, []);
  send(200, {});
});
await new Promise((r) => fakeSlskd.listen(0, "127.0.0.1", r));

process.env.SLSKD_URL = `http://127.0.0.1:${fakeSlskd.address().port}`;
process.env.SLSKD_API_KEY = "test-key-0123456789abcdef";
process.env.DOWNLOAD_DIR = downloads;
process.env.INCOMPLETE_DIR = incomplete;
process.env.MEDIA_WAIT_MS = "600";

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

test("stream answers before the peer has sent anything", async () => {
  const id = encodeId("peer1", "Music\\Artist - Track.flac");
  const started = Date.now();
  const res = await fetch(`${base}/stream/${id}`);
  const body = await res.json();
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  assert.equal(body.format, "flac");
  assert.equal(body.codec, "flac");
  assert.equal(body.encrypted, false);
  assert.ok(body.url.startsWith(`${base}/media/`), body.url);
  // The old code waited STREAM_WAIT_MS (20s) here, which is BitChord's own ceiling.
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
});

test("a cold id (no size from a search) still answers fast", async () => {
  const id = encodeId("peer2", "Other\\Nobody - Unknown.flac");
  const started = Date.now();
  const res = await fetch(`${base}/stream/${id}`);
  const body = await res.json();
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  assert.ok(body.url.includes("/media/"));
});

test("stream reports the file's real bit depth and sample rate", async () => {
  const filename = "Library\\Radiohead - Karma Police.flac";
  fs.writeFileSync(
    path.join(downloads, "Radiohead - Karma Police.flac"),
    flacHeader({ sampleRate: 96000, bitDepth: 24, totalSamples: 12345678 }),
  );
  const res = await fetch(`${base}/stream/${encodeId("peer1", filename)}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.sampleRate, 96000);
  assert.equal(body.bitDepth, 24);
  assert.match(body.quality, /Hi-Res 24-bit \/ 96\.0 kHz/);
});

test("media waits for the first bytes, then serves them", async () => {
  const id = encodeId("peer3", "Late\\Late Arrival.flac");
  const target = path.join(incomplete, "Late Arrival.flac");
  const timer = setTimeout(() => fs.writeFileSync(target, flacHeader({ sampleRate: 44100, bitDepth: 16 })), 300);

  const res = await fetch(`${base}/media/${id}`, { headers: { Range: "bytes=0-1023" } });
  clearTimeout(timer);

  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-type"), "audio/flac");
  assert.equal((await res.arrayBuffer()).byteLength, 1024);
});

test("media gives up on its own when no bytes arrive", async () => {
  const id = encodeId("peer4", "Missing\\Never Arrives.flac");
  const started = Date.now();
  const res = await fetch(`${base}/media/${id}`);
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.ok(body.error);
  assert.ok(Date.now() - started < 2500, "the player must not be held open");
});

test("a rejected enqueue is not a miss", async () => {
  // The transfer may already be queued; slskd 500s on the second POST. Answering
  // 404 here would drop a playable track before /media ever got a chance.
  const id = encodeId("peer500", "Queued\\Already Queued.flac");
  const res = await fetch(`${base}/stream/${id}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.format, "flac");
  assert.ok(body.url.includes("/media/"));
});

test("health separates the addon being up from slskd answering", async () => {
  const res = await fetch(`${base}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "slskd");
  assert.equal(body.slskd.configured, true);
  assert.equal(body.slskd.reachable, true);
});

test("a nonsense id is a clean 404, not a crash", async () => {
  const res = await fetch(`${base}/stream/not-base64-at-all`);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});
