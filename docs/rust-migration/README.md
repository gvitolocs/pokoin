# Rust migration records

The Node → Rust port of the shared API finished on 2026-10-09
([RUST_RUNTIME.md](../RUST_RUNTIME.md)).

- [NODE_REMAINING.md](NODE_REMAINING.md): the Node usage that is left, with a proposed Rust replacement for each backend piece. Keep it current.
- [PORTING_RULES.md](PORTING_RULES.md): the parity rules the port followed.
- `api-route-inventory.json`, `live-routes-20261008.json`, `*-coverage.json`, `*-HANDOFF.txt`: dated records of the port.

Paths such as `server/pokoin-api/…`, `api/*.js` or `/app/server/…` in those records name the Node sources the port was checked against. They are not in the tree any more. Read them at the last commit that still had them: `git show 234defa6:server/pokoin-api/<file>`. The Rust tests embed their own golden fixtures and do not need these sources.
