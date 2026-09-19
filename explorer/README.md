# explorer.pokoin.com — vendored PokoinPoS explorer UI

Vendored from `/home/nez/Projects/pokoinpos/explorer` (the source of truth).
Sync with:

```bash
rsync -a --delete /home/nez/Projects/pokoinpos/explorer/ ./explorer/
```

Hosting contract (`pokoinpos/docs/public-network.md`): `explorer.pokoin.com`
is a public frontend/static metadata hostname hosted on the Vercel project
`web` alongside `pokoin.com` — NOT on a node, NOT on Caddy. The UI reads
`https://rpc.pokoin.com` client-side. Required public URLs:

- `https://explorer.pokoin.com/` (this UI)
- `https://explorer.pokoin.com/wpkn/logo.png` (256×256 downscale of the
  marketplace mark `home/logo.png`, per `docs/wpkn-token-listing.md`)
- `https://explorer.pokoin.com/wpkn-reserve.json` (pending: reserve manifest
  data must be supplied by the operator)

Routing: `vercel.json` host-based rewrites map `explorer.pokoin.com/*` to
these files. Do not serve the marketplace SPA on that host, and never point
this hostname at a node/Caddy origin (the stale A record to a residential IP
is what broke the host in Sep 2026).
