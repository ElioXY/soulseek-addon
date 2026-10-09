import test from "node:test";
import assert from "node:assert/strict";
import { cacheControlFor } from "../src/server.js";

test("complete file is edge-cacheable", () => {
  assert.equal(cacheControlFor(50716942, 50716942), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor(50716950, 50716942), "public, max-age=31536000, immutable");
});

test("partial file is never cached", () => {
  assert.equal(cacheControlFor(1000, 50716942), "no-store");
});

test("unknown expected size is never cached", () => {
  assert.equal(cacheControlFor(50716942, undefined), "no-store");
  assert.equal(cacheControlFor(50716942, 0), "no-store");
});
