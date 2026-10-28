#!/bin/sh
# Starts slskd and the addon in the same container.
#
# This is also `npm start`, because some platforms run that instead of honouring
# the image ENTRYPOINT. Starting the addon alone there would leave slskd behind.
set -eu

# State and downloads live on a volume in production. A read-only root
# filesystem with no volume makes /data unusable — that must not abort the boot,
# or the deploy crash-loops with EROFS instead of serving anything.
DATA_ROOT="${DATA_ROOT:-/data}"
if ! mkdir -p "$DATA_ROOT" 2>/dev/null || ! ( : > "$DATA_ROOT/.write-test" ) 2>/dev/null; then
  echo "[entrypoint] $DATA_ROOT is not writable (read-only filesystem or unwritable volume)." >&2
  echo "[entrypoint] falling back to ${TMPDIR:-/tmp}/slskd-data: downloads and slskd state are lost on restart." >&2
  echo "[entrypoint] attach a volume at /data, writable by uid 1000, for real use." >&2
  DATA_ROOT="${TMPDIR:-/tmp}/slskd-data"
fi
rm -f "$DATA_ROOT/.write-test" 2>/dev/null || true

APP_DIR="${APP_DIR:-$DATA_ROOT/slskd}"
DOWNLOADS="${SLSKD_DOWNLOADS_DIR:-$DATA_ROOT/downloads}"
INCOMPLETE="${SLSKD_INCOMPLETE_DIR:-$DATA_ROOT/incomplete}"
SLSKD_BIN="${SLSKD_BIN:-/usr/local/bin/slskd}"
LISTEN_PORT="${SLSKD_LISTEN_PORT:-50300}"

mkdir -p "$APP_DIR" "$DOWNLOADS" "$INCOMPLETE"

# slskd is a single-file .NET bundle: it extracts native libraries before it can
# start. On a read-only root, $HOME (/home/node) is not usable and it dies with
# "Failed to determine location for extracting embedded files". /tmp is writable
# and executable everywhere, and this is a cache, so nothing needs to persist.
BUNDLE_DIR="${DOTNET_BUNDLE_EXTRACT_BASE_DIR:-${TMPDIR:-/tmp}/dotnet-extract}"
mkdir -p "$BUNDLE_DIR" 2>/dev/null || true
if [ -w "$BUNDLE_DIR" ]; then
  export DOTNET_BUNDLE_EXTRACT_BASE_DIR="$BUNDLE_DIR"
else
  echo "[entrypoint] $BUNDLE_DIR is not writable; slskd may fail to start." >&2
fi

# Same reason: a read-only $HOME breaks any tool that wants a cache there.
if [ -z "${HOME:-}" ] || [ ! -w "${HOME}" ]; then
  HOME="${TMPDIR:-/tmp}/home"
  mkdir -p "$HOME" 2>/dev/null || true
  export HOME
fi

# src/config.js reads these; keep both processes pointed at the same disk.
export DOWNLOAD_DIR="${DOWNLOAD_DIR:-$DOWNLOADS}"
export INCOMPLETE_DIR="${INCOMPLETE_DIR:-$INCOMPLETE}"

write_config() {
  # node is guaranteed here, and its JSON escaping is valid YAML, so passwords
  # with quotes or backslashes cannot corrupt the file.
  APP_DIR="$APP_DIR" \
  SLSKD_USERNAME="$SLSKD_USERNAME" \
  SLSKD_PASSWORD="$SLSKD_PASSWORD" \
  SLSKD_API_KEY="$SLSKD_API_KEY" \
  SLSKD_DOWNLOADS_DIR="$DOWNLOADS" \
  SLSKD_INCOMPLETE_DIR="$INCOMPLETE" \
  SLSKD_LISTEN_PORT="$LISTEN_PORT" \
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const q = (v) => JSON.stringify(String(v ?? ""));
    const yaml = [
      "soulseek:",
      `  username: ${q(process.env.SLSKD_USERNAME)}`,
      `  password: ${q(process.env.SLSKD_PASSWORD)}`,
      `  listen_port: ${Number(process.env.SLSKD_LISTEN_PORT) || 50300}`,
      "directories:",
      `  downloads: ${q(process.env.SLSKD_DOWNLOADS_DIR)}`,
      `  incomplete: ${q(process.env.SLSKD_INCOMPLETE_DIR)}`,
      "web:",
      "  port: 5030",
      "  authentication:",
      "    api_keys:",
      // api_keys is a map keyed by name, not a list: a list fails validation
      // and slskd exits before the addon can talk to it.
      "      addon:",
      `        key: ${q(process.env.SLSKD_API_KEY)}`,
      "        role: readwrite",
      "        cidr: \"0.0.0.0/0,::/0\"",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(process.env.APP_DIR, "slskd.yml"), yaml);
  '
}

SLSKD_PID=""

if [ -n "${SLSKD_USERNAME:-}" ] && [ -n "${SLSKD_PASSWORD:-}" ] && [ -n "${SLSKD_API_KEY:-}" ] \
   && [ -x "$SLSKD_BIN" ]; then
  # slskd validates the key length (16-255) and exits otherwise. Say why here,
  # instead of leaving a silent crash loop in the platform logs.
  KEY_LEN=${#SLSKD_API_KEY}
  if [ "$KEY_LEN" -lt 16 ] || [ "$KEY_LEN" -gt 255 ]; then
    echo "[entrypoint] SLSKD_API_KEY must be 16-255 characters; got $KEY_LEN" >&2
    exit 1
  fi
  write_config
  # The addon talks to slskd over loopback inside this container.
  SLSKD_URL="${SLSKD_URL:-http://127.0.0.1:5030}"
  export SLSKD_URL SLSKD_API_KEY
  echo "[entrypoint] starting slskd (peer port ${LISTEN_PORT}) and the addon"
  "$SLSKD_BIN" --app-dir "$APP_DIR" &
  SLSKD_PID=$!
else
  echo "[entrypoint] SLSKD_USERNAME + SLSKD_PASSWORD + SLSKD_API_KEY not all set:" >&2
  echo "[entrypoint] running the addon alone in mock mode" >&2
fi

node src/server.js &
APP_PID=$!

shutdown() {
  [ -n "$SLSKD_PID" ] && kill -TERM "$SLSKD_PID" 2>/dev/null || true
  kill -TERM "$APP_PID" 2>/dev/null || true
}
trap shutdown TERM INT

while kill -0 "$APP_PID" 2>/dev/null; do
  if [ -n "$SLSKD_PID" ] && ! kill -0 "$SLSKD_PID" 2>/dev/null; then
    echo "[entrypoint] slskd exited; stopping the addon so the platform restarts us" >&2
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

[ -n "$SLSKD_PID" ] && kill -TERM "$SLSKD_PID" 2>/dev/null || true
wait 2>/dev/null || true
