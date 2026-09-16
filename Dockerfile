# Tanks Evolved ships as a static site with no build step, so there is nothing to
# compile and nothing to install: one stage, an nginx handing out twelve files. No
# build stage and no Node layer — at runtime nothing here executes the JS in js/,
# the visitor's browser does.

FROM nginx:1.30-alpine
# 1.30 rather than `latest`, `alpine` or `stable-alpine`: all three are floating
# aliases, so a rebuild months from now would silently be a different nginx. Pinning
# the minor series still takes 1.30.x patch releases, which is where nginx's security
# fixes land.

# Replaced wholesale rather than dropped into conf.d: the base image's nginx.conf
# includes conf.d/*.conf, so a file there would merge with ours (bringing its own
# listen 80 and its own defaults) instead of replacing it.
COPY nginx.conf /etc/nginx/nginx.conf
# Same reason, other direction: our config does not include conf.d, so the base
# image's default.conf is dead weight and a stale server block for someone to trip
# over later. 50x.html goes for the same reason — it is the stock nginx error page,
# nothing here references it, and leaving it in the document root would mean the image
# is not quite "these three paths and nothing else".
RUN rm -f /etc/nginx/conf.d/default.conf /usr/share/nginx/html/50x.html

# Exactly the three paths the page serves. tools/ and README.md are deliberately
# absent: nothing at runtime reads them, and this image's document root is served over
# HTTP, so copying tools/ would publish the Node test harness (check-determinism.js,
# check-ui.js) at the same URLs as the game itself. Those tools run against a git
# checkout in CI, never against the running container. .dockerignore keeps them out of
# the build context too; these explicit COPYs are what make the served tree immune to
# that file changing.
COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/

# This chown is the entire cost of running unprivileged. nginx's temp directories are
# compiled into the binary as /var/cache/nginx/{client_body,proxy,fastcgi,uwsgi,scgi}_temp
# and the worker creates them at startup — as the user it runs as, which cannot write
# to the root-owned directory the base image leaves behind. With this, plus the
# writable pid path in nginx.conf, the container needs no root at all, so it also runs
# under a read-only root filesystem and in rootless runtimes such as podman.
RUN chown -R nginx:nginx /var/cache/nginx
USER nginx

# Not 80: the process is not root, so a privileged port is not even an option. 8080
# works through a plain `docker run -p 8080:8080`, and through any other host port
# mapped onto it. The base image's CMD (`nginx -g 'daemon off;'`) is inherited as-is.
EXPOSE 8080

# busybox wget is already in the image, so this costs nothing and gives `docker compose
# up` a real readiness signal instead of "the container started".
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
