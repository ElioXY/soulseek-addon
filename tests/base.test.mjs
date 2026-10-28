import test from "node:test";
import assert from "node:assert/strict";
import { resolveBaseUrl } from "../src/server.js";

// The stream body has to carry an absolute URL. On a fresh deploy nobody sets
// PUBLIC_BASE_URL, so the origin is read from the request that was just served.

test("a configured base wins and loses its trailing slash", () => {
  assert.equal(
    resolveBaseUrl({ host: "internal:3000" }, "https://music.example.com/"),
    "https://music.example.com"
  );
});

test("proxy headers decide the public origin", () => {
  assert.equal(
    resolveBaseUrl({ "x-forwarded-proto": "https", "x-forwarded-host": "addon.example.com" }),
    "https://addon.example.com"
  );
});

test("the first value wins when a proxy appends a list", () => {
  assert.equal(
    resolveBaseUrl({ "x-forwarded-proto": "https,http", "x-forwarded-host": "a.example, b.internal" }),
    "https://a.example"
  );
});

test("public hosts default to https, loopback to http", () => {
  assert.equal(resolveBaseUrl({ host: "addon.example.com" }), "https://addon.example.com");
  assert.equal(resolveBaseUrl({ host: "localhost:3000" }), "http://localhost:3000");
  assert.equal(resolveBaseUrl({ host: "127.0.0.1:3000" }), "http://127.0.0.1:3000");
});

test("no headers falls back to localhost on the configured port", () => {
  assert.match(resolveBaseUrl({}), /^http:\/\/localhost:\d+$/);
});
