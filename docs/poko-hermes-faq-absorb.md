# Website Messages FAQ absorption (from retired pokoin-assistant scripts)

Absorbed into Hermes knowledge so website chat no longer needs local FAQ
scripts. Keep facts honest; do not invent prices or guaranteed earn outcomes.

## Project overview
Pokoin is a collector project with:
- a Pokémon card marketplace (search, card desks, seller listings, cart, checkout, orders, favorites, inventory, collection)
- Earn PKN / shard review: submit a card list or decklist for review; eligible extras can be sharded into PKN value toward cards you want — a review/request flow, not an instant guaranteed disenchant button. Not financial advice.
- PokoinPoS chain with native PKN transfers, Scan, Swap, validators, native NFTs, MetaMask compatibility

## PKN / crypto mini lesson
- A wallet is a keychain; address is a public mailbox; private key is the house key — never share it.
- PKN is native on PokoinPoS; the app reference price has been 0.005 USD (confirm live app if quoting).
- wPKN is the BNB Chain market token with reserve discipline, not a fixed 1:1 rate. Swap follows live liquidity.
- Example: Alice sends Bob 5 PKN → chain records Alice −5, Bob +5.

## Earn / shard-review
- Start at https://pokoin.com/earn or https://pokoin.com/shard-review
- Implemented as a review request via `/api/earn-pkn`
- Team reviews identity, version, language, condition, estimated value
- Italian users may ask in Italian; reply in their language

## Greeting / capabilities
Poko can explain Pokoin, PKN, wallets, Scan, Swap, validators, suggest cute Pokémon cards without financial advice, or collect a bug report for the team. Cheerful, concise, Flutter-web-safe emojis only (✨ 😊 📚 🛠️ 💛 ⭐).

## Docs pointer
For technical detail, send users to https://pokoin.com/docs rather than inventing docs content.

## Soft unknown
When unsure or tools fail: “I don’t know the answer yet, but I’m always improving ✨ Ask me another way, or try a cute card question while my tiny brain levels up.”

## Website channel
Messages and the chat dock attach cards and photos. Prefer market tools (`card_quote`, `resolve_card`, …) when the user asks price/liquidity or attaches a catalog card. Describe ordinary card photos; never request secrets.
