# One image, two processes: slskd (the SoulSeek daemon) and this addon.
#
# They have to run together: the addon serves /media/:id from the same disk slskd
# downloads into, so a separate host would hand BitChord URLs nobody can read.
#
# With SLSKD_USERNAME + SLSKD_PASSWORD + SLSKD_API_KEY set, both start and the
# addon answers with real SoulSeek results. Without them the image still runs the
# addon alone in mock mode, which is what the CI smoke test exercises.

FROM node:22-bookworm-slim

ARG SLSKD_VERSION=0.26.2

# Paths are decided by the entrypoint: baking /data here would break platforms
# whose root filesystem is read-only and have no volume mounted yet.
ENV NODE_ENV=production \
    PORT=3000 \
    SLSKD_LISTEN_PORT=50300

# slskd publishes a self-contained linux-x64 build; .NET still needs ICU and
# OpenSSL from the base image. curl/unzip are build-only, so they are removed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini libicu72 libssl3 curl unzip \
 && curl -fsSL -o /tmp/slskd.zip \
      "https://github.com/slskd/slskd/releases/download/${SLSKD_VERSION}/slskd-${SLSKD_VERSION}-linux-x64.zip" \
 && mkdir -p /opt/slskd \
 && unzip -q /tmp/slskd.zip -d /opt/slskd \
 && BIN="$(find /opt/slskd -type f -name slskd -print -quit)" \
 && test -n "$BIN" \
 && chmod +x "$BIN" \
 && ln -s "$BIN" /usr/local/bin/slskd \
 && rm -f /tmp/slskd.zip \
 && apt-get purge -y --auto-remove curl unzip \
 && rm -rf /var/lib/apt/lists/*

# slskd is a single-file .NET bundle that extracts native libraries (sqlite, …)
# on first run. Extract them HERE so a read-only root filesystem never has to
# write: the official image does the same with /.net.
ENV DOTNET_BUNDLE_EXTRACT_BASE_DIR=/.net
RUN mkdir -p /.net \
 && (slskd --version > /dev/null 2>&1 || true) \
 && test -n "$(ls -A /.net)" \
 && chmod -R a+rX /.net

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# Also at its repo path: some platforms run `npm start`, which calls this file.
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh ./docker/entrypoint.sh \
 && mkdir -p /data/slskd /data/downloads /data/incomplete \
 && chown -R node:node /app /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
