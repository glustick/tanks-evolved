# Tanks Evolved — the Phase 1 server: accounts, sessions and storage, plus the client it
# belongs to, from one process on one origin.
#
# Build from the REPOSITORY ROOT, not from this directory:
#
#   docker build -f server/Dockerfile -t tanks-evolved-server:local .
#
# The context has to be the root because this image serves index.html, css/ and js/, which
# live above server/ — and serving them from the same origin as /api/ is what takes CORS
# and cross-site cookie problems out of the design entirely.

FROM node:24-alpine
# 24, not `latest` or `current`: accounts are stored through node:sqlite, which is
# unflagged from 23.4 and is the reason this major is the floor. Within 24.x this tag still
# follows patch releases, which is where Node's security fixes land.

WORKDIR /app

# HOST=0.0.0.0 rather than the code's 127.0.0.1 default: a listener bound to loopback
# inside a container namespace is unreachable from outside it, so the default would make
# every published port silently dead. TANKS_DB moves the database to a path of its own so
# the bind mount in compose.yaml has exactly one thing to mount over.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8081 \
    TANKS_DB=/data/tanks.db

# Only the files the process reads at runtime, listed as paths rather than `COPY . .`:
# tools/ (the browser and simulation harness), server/test/, the README and the git history
# have no business in this image. The three client paths are here because the allowlist in
# server/lib/static.js serves exactly them.
COPY server/index.js /app/server/index.js
COPY server/lib/ /app/server/lib/
COPY index.html /app/index.html
COPY css/ /app/css/
COPY js/ /app/js/

# The database directory, owned by the user the process runs as, so the image works with no
# mount at all (`docker run -p 8081:8081 tanks-evolved-server:local`). A bind mount over
# /data replaces both the directory and its ownership, which is why compose.yaml names the
# uid the host directory has to belong to.
RUN mkdir -p /data && chown node:node /data

# Declared as a volume for one specific reason: `--read-only` is the hardening this project
# uses everywhere, and a read-only root filesystem also makes this directory read-only — the
# server then dies at boot with "cannot open the database /data/tanks.db", which looks like
# a bug rather than a missing mount. A volume under a read-only root filesystem is writable,
# so `docker run --read-only` works with no extra flags. An explicit mount (compose.yaml's
# bind mount to the host) still takes precedence over this.
VOLUME /data

# Running as the unprivileged user is the whole of what this image needs to be safe under
# a read-only root filesystem: the process writes nothing outside /data (SQLite puts its
# WAL and shared-memory files next to the database) and nothing needs root to open 8081.
USER node

EXPOSE 8081

# There is no curl or wget in this base image, but there is node — a complete HTTP client
# that costs nothing to use. The check asks /api/health rather than the page on purpose:
# that endpoint is answered by the running process and reports the version it read from
# js/version.js, so it distinguishes "something is listening" from "the database opened and
# this build is serving". A page fetch would pass even with the storage layer dead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8081')+'/api/health').then(r=>r.json()).then(b=>process.exit(b&&b.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/index.js"]
