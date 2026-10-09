import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

const srv = createServer();
await new Promise((r) => srv.listen(0, r));
after(() => srv.close());
const base = `http://localhost:${srv.address().port}`;
const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
};

test("manifest has stable id + resources", async () => {
  const { status, body } = await get("/manifest.json");
  assert.equal(status, 200);
  assert.ok(body.id);
  assert.ok(body.resources.includes("search"));
});

test("search returns tracks array", async () => {
  const { status, body } = await get("/search?q=midnight");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.tracks));
  // Real SoulSeek mode may legitimately return zero hits; mock mode has fixtures.
  for (const t of body.tracks) assert.ok(t.id && t.title);
});

test("stream returns playable URL or clean 404", async () => {
  const res = await get("/stream/mock_midnight_signal");
  // Mock mode: 200 + playable URL. Real slskd mode: 404 clean miss (unknown id).
  assert.ok([200, 404].includes(res.status));
  if (res.status === 200) {
    assert.ok(res.body.url.startsWith("http"));
    assert.equal(res.body.encrypted, false);
  } else {
    assert.ok(res.body.error);
  }

  const miss = await get("/stream/does_not_exist");
  assert.equal(miss.status, 404);
});
