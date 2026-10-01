# server/server/ — runtime `server/` helper mirror

On the Pi, each API release (`/srv/pokoin/api/current/`) has two sibling dirs:
`api/` (handlers — what `server/pokoin-api/` deploys into) and `server/`
(shared helpers such as `_firebase.js`, `_marketplace_db.js`,
`_marketplace_game.js`). Handlers require them as `../server/_firebase`, which
only resolves against that runtime layout.

This directory mirrors the runtime `server/` helper files byte-for-byte so the
same requires resolve during unit tests (`node --test
server/pokoin-api/*.test.js`). Files are copied from
`cardvault/pokemon_card_vault/api/` (parity copies). Deps come from
`server/package.json` (`npm install --prefix server`). Deploy scripts stage
only `server/pokoin-api/` and are unaffected by this directory.
