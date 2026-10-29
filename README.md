# soulseek-addon — BitChord addon for the SoulSeek network

BitChord talks to 3 `GET` routes on this server (`/manifest.json`, `/search`, `/stream/:id`).
SoulSeek has no HTTP API, so this server is a **gateway**: it logs into SoulSeek via
**slskd** (headless daemon — no desktop app needed) and serves the bytes back over HTTPS.

## Do I need SoulSeek installed?

**Short: something must stay logged into SoulSeek, but not the desktop app.**

- SoulSeek is a logged-in P2P network. There is no public/anonymous search API.
- This repo runs in **mock mode** with zero SoulSeek setup (for BitChord wiring tests).
- The Docker image ships **slskd and this addon together**, so one deploy is enough.

## Quickstart (mock — no SoulSeek, 30s)

```bash
node src/server.js
# GET /manifest.json, /search?q=midnight, /stream/mock_midnight_signal
npm test
```

Add `http://localhost:3000/manifest.json` in BitChord: Settings → Sources.
(Mock streams are public sample MP3s so playback works before SoulSeek is wired.)

## Deploy (one container, both processes)

`Dockerfile` puts **slskd and the addon in the same image**: slskd downloads into
`/data/downloads`, and the addon serves `/media/:id` from that same folder. They need
one shared disk, so they share a container.

```bash
cp .env.example .env          # SLSKD_USERNAME, SLSKD_PASSWORD, SLSKD_API_KEY
docker compose up -d --build
```

Or without compose:

```bash
docker run -d -p 3000:3000 -p 50300:50300 \
  -e SLSKD_USERNAME=you -e SLSKD_PASSWORD=secret -e SLSKD_API_KEY="$(openssl rand -hex 24)" \
  -v soulseek-data:/data soulseek-addon
```

`docker/entrypoint.sh` writes `/data/slskd/slskd.yml` at boot from those three variables,
so the key slskd expects and the key the addon sends can never drift apart. Without them
the image still starts and the addon runs alone in mock mode — useful for wiring BitChord
before creating a SoulSeek account.

Three things decide whether it actually works:

- **Port 50300/tcp** is the SoulSeek peer port. Publish it on a host that can (VM, own
  server). On an app-only PaaS it stays closed and slskd reports as firewalled: search and
  downloads still happen, with longer queues and fewer peers willing to serve.
- **`/data` must persist.** Downloads, slskd's SQLite state and its config live there;
  without a volume each restart starts from scratch. On a platform with a read-only
  root filesystem and no volume, the entrypoint does not crash with `EROFS`: it logs a
  warning and falls back to `/tmp/slskd-data`, so the addon still boots. Attach a volume
  writable by uid 1000 (the `node` user) to keep anything.
- **One session per username.** Soulseek kicks the older client when the same name logs
  in twice, so slskd and SoulseekQt need different accounts (`another client logged in
  using the same username` in the logs). slskd registers an unused name on its first
  login. Two instances of this container fight each other the same way, so keep one.
- **RAM.** slskd is a .NET process next to Node: budget ~512 MB, not 128 MB.

`hostless.yaml` deploys the same image as an app (HTTP health check on `/health`,
0.25 vCPU / 512 MB, inside the free pool). Open `/` after the deploy: it prints the
manifest URL to paste into BitChord, the running mode and a sample search. `/health`
also reports whether slskd itself answers (`slskd.reachable`) and whether Soulseek has
it logged in (`slskd.state`, `slskd.loggedIn`) — the difference between "nobody has
this track" and "another client took the username and slskd is being kicked".

| Variable | Default | What it does |
|---|---|---|
| `SLSKD_USERNAME` / `SLSKD_PASSWORD` | *(empty)* | SoulSeek account; a new username registers on first login |
| `SLSKD_API_KEY` | *(empty)* | Shared secret for slskd's API, 16-255 chars, written into `slskd.yml` at boot |
| `SLSKD_LISTEN_PORT` | `50300` | SoulSeek peer port |
| `PORT` | `3000` | Addon HTTP port; platforms that inject `PORT` work as-is |
| `PUBLIC_BASE_URL` | *(derived from the request)* | Pins a canonical origin for stream URLs |
| `APP_DIR` | `/data/slskd` | slskd config, logs and database |
| `DOWNLOAD_DIR` / `INCOMPLETE_DIR` | `/data/downloads`, `/data/incomplete` | The disk both processes share |
| `SEARCH_TIMEOUT_MS` / `MEDIA_WAIT_MS` | `8000` / `6000` | Search collection time, and how long `/media` waits for a download's first bytes |
| `DELETE_AFTER_MS` | `300000` | Delete a track this long after the last byte was sent to a player (every request restarts the clock); `-1` keeps everything |
| `MAX_STORAGE_MB` | `700` | Upper bound for downloads + incomplete; oldest files evicted first, `0` disables. The sweep also keeps 128 MB of the volume free |
| `CLEANUP_INTERVAL_MS` | `60000` | How often the cap is checked |

Flow: `BitChord → /search → slskd POST /api/v0/searches {searchText} → poll responses →
/stream/:id → slskd download → serve /media/:id (Range-capable)`.

**`/stream` never waits for the transfer.** BitChord aborts an addon call at 20s, and a
SoulSeek queue routinely takes longer, so waiting there made every play time out and fall
back to YouTube — which is why lossless tracks were being heard as 128kbps AAC. `/stream`
enqueues the download, answers at once with the `/media/:id` URL, and the waiting moves to
`/media`, bounded by `MEDIA_WAIT_MS` (6s, inside ExoPlayer's 8s HTTP timeout). A file
already on disk answers immediately, with no slskd round trip.

Running the two apart (addon as an app, slskd elsewhere) only half works: search answers,
but `/media/:id` reads the addon's own disk, so playback 404s.

## Small volumes (1 GiB) — deletion after playback

`src/cleanup.js` keeps the volume from filling up, which would break every later
transfer (slskd cannot write, `/media` 404s, the source looks dead):

- **Played → deleted.** A *complete* file served to a player is deleted
  `DELETE_AFTER_MS` after its last byte (5 min). Every new request restarts that
  clock, so a seek or a second listener keeps the file, and a file with an open
  reader is never unlinked mid-stream. Played-through tracks therefore free their
  space minutes after the song ends — the sweep below is what bounds the rest.
- **Hard cap.** Every `CLEANUP_INTERVAL_MS` the download dirs are measured and the
  oldest files are evicted (down to 90% of `MAX_STORAGE_MB`) until the volume fits.
  Prefetched tracks nobody played are the usual offenders.
- **slskd's record goes too.** A completed transfer left in slskd's list makes the
  same track refuse to re-enqueue, so a replay after eviction would silently never
  produce a file. Deletions cancel the transfer with `?remove=true`, and each sweep
  clears leftover completed records.
- `/health → storage` reports `usedBytes`, `files`, `deleted`, `evicted`, so the
  effect is visible without logs.

On a 1 GiB volume leave headroom: the image, `slskd.yml` and its database live
there too. `MAX_STORAGE_MB=700` is the default; the sweep also stops evicting at 128 MB of
free space on the volume, so a platform file growing cannot fill it either.

## Notes / limits

- Search waits `SEARCH_TIMEOUT_MS` (default 8s) for the distributed network — slower than
  normal addons. Empty results = soft miss, BitChord tries the next source.
- Peer offline/queued → `/stream` answers optimistically, `/media` gives up after
  `MEDIA_WAIT_MS` with a 404 and BitChord falls through. An enqueue that fails *instantly*
  (unknown file, peer gone) is still a 404 on `/stream`, so a dead id costs no wait.
- Search rows put lossless ahead of lossy: BitChord plays the first row it matches,
  so ordering by peer speed alone handed out 128kbps MP3s while the FLACs sat fifth.
  Within each quality tier, free-slot/faster/shorter-queue peers still come first.
- Quality is reported honestly from the shared file (no fake lossless badges): the
  `sampleRate`/`bitDepth` sent to BitChord are parsed from the FLAC's own STREAMINFO once
  the file is on disk, so a 24/96 rip shows as Hi-Res instead of plain "Lossless".
- slskd API shape drifts between versions; version-specific code is isolated in
  `src/slskd.js → enqueueDownload()`. File serving reads the shared `DOWNLOAD_DIR`.
- BitChord requires HTTPS + absolute URLs in production.

## Edge cache (Cloudflare, branch `cf-edge-cache`)

`/media/:id` sends completeness-gated headers so a CDN can offload repeats:

- Complete file → `Cache-Control: public, max-age=31536000, immutable` (safe: one id = one immutable file)
- Still-downloading file → `Cache-Control: no-store` (never poison the edge with truncated audio)

Dashboard setup (2 min, Cloudflare free tier):

1. Cache Rule: host = your addon host, path `/soulseek/media/*` (adjust prefix to yours)
   → Cache Everything, Edge TTL ~1 month
2. Turn on Tiered Cache (Smart) so one PoP's fetch serves all regions
3. Verify: `curl -I <media-url>` twice → second response has `CF-Cache-Status: HIT`

Notes: first fetch per region still pays SoulSeek time; free-tier edge eviction is
best-effort (rare tracks re-fetch from origin — covered by the local download cache);
per-file cap is 512MB (fine for audio). Keep `INCOMPLETE_DIR` as a separate directory
from `DOWNLOAD_DIR` so completed files skip the per-request slskd check.

## Origin disk (pairs with edge cache)

Edge caching doesn't shrink origin disk by itself — evicted edge copies re-fetch
from origin. The fix: with edge repeats absorbing replays, drop the origin TTL.
`deploy/prune.sh` (daily via `deploy/soulseek-prune.timer`) deletes files neither
read nor written in `TTL_HOURS` (default 48) plus a `MAX_MB` safety cap (default 4096):

```bash
# /root/soulseek-addon/prune.env — with edge cache on, 12h keeps origin tiny:
TTL_HOURS=12
MAX_MB=4096
```

Set `TTL_HOURS` in `prune.env`, install the timer from `deploy/`, done.
