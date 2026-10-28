# SoulSeek gateway for BitChord — zero runtime dependencies (node:http + node:fs).
# Build:  docker build -t soulseek-addon .
# Run:    docker run -p 3000:3000 -e SLSKD_URL=... -e SLSKD_API_KEY=... soulseek-addon
#
# Mock mode needs no configuration at all: without SLSKD_URL + SLSKD_API_KEY the
# addon serves fixture tracks and public sample audio, which is enough to wire it
# into BitChord and check the manifest.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DOWNLOAD_DIR=/data/downloads \
    INCOMPLETE_DIR=/data/incomplete

WORKDIR /app
COPY package.json ./
COPY src ./src

# /data is where a platform volume gets mounted and where slskd writes when both
# run on the same host; ownership is set now so the non-root user can read it.
RUN mkdir -p /data/downloads /data/incomplete && chown -R node:node /app /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
