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
  without a volume each restart starts from scratch.
- **RAM.** slskd is a .NET process next to Node: budget ~512 MB, not 128 MB.

`hostless.yaml` deploys the same image as an app (HTTP health check on `/health`,
0.25 vCPU / 512 MB, inside the free pool). Open `/` after the deploy: it prints the
manifest URL to paste into BitChord, the running mode and a sample search.

| Variable | Default | What it does |
|---|---|---|
| `SLSKD_USERNAME` / `SLSKD_PASSWORD` | *(empty)* | SoulSeek account; a new username registers on first login |
| `SLSKD_API_KEY` | *(empty)* | Shared secret for slskd's API, 16-255 chars, written into `slskd.yml` at boot |
| `SLSKD_LISTEN_PORT` | `50300` | SoulSeek peer port |
| `PORT` | `3000` | Addon HTTP port; platforms that inject `PORT` work as-is |
| `PUBLIC_BASE_URL` | *(derived from the request)* | Pins a canonical origin for stream URLs |
| `APP_DIR` | `/data/slskd` | slskd config, logs and database |
| `DOWNLOAD_DIR` / `INCOMPLETE_DIR` | `/data/downloads`, `/data/incomplete` | The disk both processes share |
| `SEARCH_TIMEOUT_MS` / `STREAM_WAIT_MS` | `8000` / `20000` | How long to wait on the network |

Flow: `BitChord → /search → slskd POST /api/v0/searches {searchText} → poll responses →
/stream/:id → slskd download → serve /media/:id (Range-capable)`.

Running the two apart (addon as an app, slskd elsewhere) only half works: search answers,
but `/media/:id` reads the addon's own disk, so playback 404s.

## Notes / limits

- Search waits `SEARCH_TIMEOUT_MS` (default 8s) for the distributed network — slower than
  normal addons. Empty results = soft miss, BitChord tries the next source.
- Peer offline/queued → `/stream` returns `404` → BitChord falls through. Correct behavior.
- Quality is reported honestly from the shared file (no fake lossless badges).
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
