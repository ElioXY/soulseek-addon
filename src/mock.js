// Mock catalogue: lets you test the full BitChord contract with NO SoulSeek setup.
// Streams point at a public sample file so playback works end-to-end in dev.
// Real SoulSeek results replace this as soon as SLSKD_URL + SLSKD_API_KEY are set.

export const MOCK_TRACKS = [
  {
    id: "mock_midnight_signal",
    title: "Midnight Signal",
    artist: "Example Artist",
    album: "Night Drive",
    duration: 242,
    format: "mp3",
    audioQuality: "STANDARD",
  },
  {
    id: "mock_neon_skyline",
    title: "Neon Skyline",
    artist: "Example Artist",
    album: "Night Drive",
    duration: 198,
    format: "mp3",
    audioQuality: "STANDARD",
  },
];

const SAMPLE_MP3 = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";

export function searchMock(query) {
  const q = (query ?? "").toLowerCase();
  if (!q) return MOCK_TRACKS;
  return MOCK_TRACKS.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
}

export function streamMock(id) {
  const track = MOCK_TRACKS.find((t) => t.id === id);
  if (!track) return null;
  return {
    url: SAMPLE_MP3,
    format: "mp3",
    quality: "Sample · 128 kbps (mock, no SoulSeek connected)",
    codec: "mp3",
    container: "mp3",
    manifest: "none",
    encrypted: false,
    bitrate: 128000,
  };
}
