import test from "node:test";
import assert from "node:assert/strict";
import { parseSoulseekMetadata, rankTracks, fallbackQueries, describeFile } from "../src/audio.js";

test("slskd's bitRate spelling is read, not just bitrate", () => {
  // slskd search responses use `bitRate`; reading only `bitrate` left every MP3
  // row reporting UNKNOWN instead of its real 320.
  assert.equal(describeFile("a.mp3", { bitRate: 320000 }).audioQuality, "HIGH");
  assert.equal(describeFile("a.mp3", { bitRate: 128000 }).audioQuality, "STANDARD");
  assert.equal(describeFile("a.mp3", {}).audioQuality, "UNKNOWN");
});

test("numbered file in album folder", () => {
  const m = parseSoulseekMetadata("Dhurandhar (2025)/03 - Title Track.mp3");
  assert.equal(m.title, "Title Track");
  assert.equal(m.album, "Dhurandhar");
});

test("Artist/Album/numbered-title layout", () => {
  const m = parseSoulseekMetadata("Music\\RADWIMPS\\Weathering With You\\03 Grand Escape (feat. Toko Miura).flac");
  assert.equal(m.artist, "RADWIMPS");
  assert.equal(m.album, "Weathering With You");
  assert.equal(m.title, "Grand Escape (feat. Toko Miura)");
});

test("Artist - Album parent folder", () => {
  const m = parseSoulseekMetadata("shares\\Man With A Mission\\絆ノ奇跡 + コイコガレ (2023)\\02 - Koi Kogare.flac");
  assert.equal(m.artist, "Man With A Mission");
  assert.equal(m.title, "Koi Kogare");
});

test("plain Artist - Title", () => {
  const m = parseSoulseekMetadata("Hanumankind - Naal Nachna.mp3");
  assert.equal(m.artist, "Hanumankind");
  assert.equal(m.title, "Naal Nachna");
});

test("quality tags stripped, identity kept", () => {
  const m = parseSoulseekMetadata("Artist - Song [FLAC 24-bit].flac");
  assert.equal(m.title, "Song");
});

test("ranking puts exact recording first", () => {
  const tracks = [
    { id: "a", title: "Naal Nachna", artist: "Hanumankind", album: "Dhurandhar" },
    { id: "b", title: "Title Track", artist: "Hanumankind", album: "Dhurandhar" },
  ];
  const ranked = rankTracks("Dhurandhar Title Track", tracks);
  assert.equal(ranked[0].id, "b");
});

test("fallback queries split parentheticals", () => {
  const alts = fallbackQueries("Suzume (ft. Toaka)");
  assert.ok(alts.includes("Suzume"));
});
