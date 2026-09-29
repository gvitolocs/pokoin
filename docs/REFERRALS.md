# Invite & Earn and the Ambassador program

Three ways to grow with Pokoin, each for a different kind of person:

| | Invite & Earn | Ambassador | Distributor |
| --- | --- | --- | --- |
| For | Everyone | Active community members | Commercial partners |
| You do | Invite collectors | Complete missions | Bring sales and volume |
| You get | 20 PKN each side | Status, perks, early access | Negotiated deal ([ASSOCIATE.md](ASSOCIATE.md)) |

## Invite & Earn

Every account with a username has an invite link: `pokoin.com/join/<username>`
(`?ref=<username>` on any page works too).

1. The link stores the code in the browser (`market/src/referral.js`,
   localStorage, 30 days).
2. Once the visitor is signed in, `components/ReferralClaimer.jsx` posts
   `POST /api/marketplace-referral {action:'claim', code}` once.
3. The claim writes Firestore `referrals/{invitedUid}` =
   `{referrerUid, status:'pending', claimedAtMs, …}`.
4. When the invited account completes a **first purchase or first sale**
   (an order with `paymentStatus` paid / escrow / released /
   partially_refunded, created after the claim), both sides get **20 PKN**
   from the treasury (`@pokoin`) in one Firestore transaction with balanced
   `ledger_entries` (`referral_reward_received` / `referral_reward_sent`),
   and the referral becomes `rewarded`.

Settlement runs on every `GET /api/marketplace-referral` for the caller's own
referrals, and for everyone every 10 minutes from
`pokoin-referral-reconcile.timer` on the Pi
(`docker exec pokoin-oracle-api node /app/api/referral-reconcile.js`,
`--dry-run` counts pending).

Guardrails (`server/pokoin-api/_referral_core.js`):

- The invited account must be new: created within **14 days** and no
  qualifying order yet. Old accounts get 409 `not_new`.
- No self-referral, no circular pairs, one inviter per account, ever.
- Orders between inviter and invited do not qualify.
- An inviter earns at most **50** rewards per 30 days; past the cap the
  invited collector still gets 20 PKN, the inviter gets 0.
- A treasury balance short of the payout leaves the referral pending (retried next run).

Pages: `/invite` (link, stats, invite list), `/join/:code` (landing →
Create account). Tests: `server/pokoin-api/_referral_core.test.js`,
`marketplace-referral.test.js`, `market/src/referral.test.js`.

## Ambassador program

Public page: `pokoin.com/ambassadorprogram`. Signed-in visitors see their
trainer card (tier, mission meter, next unlock).

Missions (`server/pokoin-api/_ambassador_core.js`, copy in
`market/src/ambassador-program.js`):

| Key | Mission | Verified by |
| --- | --- | --- |
| `referrals` | Bring 3 collectors | Automatic: 3 rewarded referrals |
| `content` | Create content | Pokoin team |
| `bug_report` | Report bugs or data errors | Pokoin team |
| `seller_onboard` | Onboard a seller with 20+ cards | Pokoin team |
| `community_event` | Run a community event | Pokoin team |
| `feedback` | Give product feedback | Pokoin team |

Tiers: **Collector** → **Ambassador** (3 missions, or `role='ambassador'` on
the roster) → **Senior Ambassador** (5 missions and 10 activated referrals)
→ **City Ambassador** (roster ambassador with `city` set).

Recording a verified mission (nezopt writer, `scripts/sql/096_ambassador_program.sql`):

```sql
insert into public.marketplace_ambassador_contributions (email, mission, note, link, verified_by)
values ('someone@gmail.com', 'content', 'TikTok pull video', 'https://…', 'pokoin-team');
```

Making someone a City Ambassador:

```sql
update public.marketplace_associates set city = 'Milano', updated_at = now()
 where email = 'someone@gmail.com' and role = 'ambassador';
```

**Founder Ambassador** (`role='founder_ambassador'`, `scripts/sql/097_founder_ambassador.sql`):
Andrea Paolo Ciliberti, the program's first ambassador — a one-off title. It
progresses like any ambassador, shows a gold/violet "Founder Ambassador" badge
on search and his shop, and `/associate` opens with a personal congratulations
hero and the No. 001 founder medal (`market/src/components/FounderWelcome.jsx`).
Preview locally: `/associate?associatePreview&role=founder_ambassador`.

Roster ambassadors see the program on `/associate` (missions, verified
contributions, Invite & Earn stats, perks) instead of the distributor
royalty desk.

## Deploy

1. Apply `scripts/sql/096_ambassador_program.sql` on the writer (the Pi
   replica streams it).
2. `scripts/deploy-referral-api.sh <origin/main commit>` — API overlay
   (referral + associate city), route manifest, reconcile timer.
3. `scripts/deploy-web.sh <commit>` for the pages.
