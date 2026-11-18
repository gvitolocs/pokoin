# One-off image for a major upgrade of the marketplace Postgres: the NEW
# official Alpine image plus the OLD release's binaries under /opt/pg-old,
# which pg_upgrade needs side by side. Postgres installs are relocatable, so
# the old binaries find their lib/ and share/ next to bin/.
#
#   docker build -t pokoin-pg-upgrade:17-to-19 \
#     --build-arg OLD=17.11 --build-arg NEW=19.1 infra/postgres-upgrade
#
# OLD must be the exact image the cluster runs, NEW the target, and both on
# the same Alpine release (musl and ICU must match what the data was built
# against). docs/POSTGRES_VERSION.md is the runbook.
ARG OLD=17.11
ARG NEW=19beta4
ARG ALPINE=3.24
FROM postgres:${OLD}-alpine${ALPINE} AS old

FROM postgres:${NEW}-alpine${ALPINE}
# The data directories belong to the host user the writer runs as
# (--user 1000:1000); initdb and pg_upgrade need a passwd entry for it.
ARG PGUID=1000
ARG PGGID=1000
RUN addgroup -g "$PGGID" pgowner && adduser -D -H -u "$PGUID" -G pgowner pgowner \
 && mkdir -p /work && chown "$PGUID:$PGGID" /work
COPY --from=old /usr/local/bin /opt/pg-old/bin
COPY --from=old /usr/local/lib/postgresql /opt/pg-old/lib/postgresql
COPY --from=old /usr/local/share/postgresql /opt/pg-old/share/postgresql
COPY upgrade-cluster.sh /usr/local/bin/upgrade-cluster.sh
USER ${PGUID}:${PGGID}
ENTRYPOINT ["/usr/local/bin/upgrade-cluster.sh"]
