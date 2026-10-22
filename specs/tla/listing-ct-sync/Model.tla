---------------------------- MODULE Model ----------------------------
(***************************************************************************)
(* One Card Rails copy, from the Seller API `list` call to one CardTrader  *)
(* product, for a seller whose inventory link pushes (pokoin_to_ct/both).  *)
(*                                                                         *)
(* Card Rails retries `list` with one idempotency key; two attempts may    *)
(* run at once and a server can die between any two steps                 *)
(* (handlers/seller_api.rs `list`, listings.rs `create_listing_keyed`).   *)
(* The listing is created active when Pokoin quotes a price, paused at 0   *)
(* otherwise; a later price (Seller API `update`, or the                   *)
(* `price-unpriced-listings` job) puts it on sale. The seller reconcile    *)
(* (cardtrader/sync.rs, link.rs) takes a complete export, links products   *)
(* that name the listing (`user_data_field`), settles vanished ones from   *)
(* seller orders, releases stale in-doubt claims, and creates the product  *)
(* of an active unlinked listing behind a compare-and-set claim. A         *)
(* CardTrader create can be answered, refused, or in doubt: applied or not *)
(* with the answer lost, or still in flight and applied later (within      *)
(* Grace ticks). The product can sell on CardTrader; the order webhook can *)
(* be delivered late, twice, or never.                                     *)
(*                                                                         *)
(* Fixed = FALSE is origin/main 1259f2c2; Fixed = TRUE is this branch.     *)
(* OtherGame = TRUE: the copy is a Riftbound (any non-Pokémon) card.       *)
(* README.md maps every action to the Rust code.                          *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS
    Reqs,          \* concurrent Card Rails `list` attempts with the same key
    MaxCrashes,    \* server deaths during `list`
    MaxInDoubt,    \* CardTrader creates whose answer is lost
    MaxRejects,    \* CardTrader creates refused (4xx, 429)
    MaxLostHooks,  \* order webhooks never delivered
    Grace,         \* stale-claim grace, in ticks (STALE_CLAIM_GRACE_SECS)
    Quoted,        \* Pokoin's `sold-prices` quote has a price for the copy
    OtherGame,     \* the copy is not a Pokémon card
    LandsInGrace,  \* assumption: an in-flight create lands within Grace ticks
    Fixed

VARIABLES
    key,       \* seller_api_listing_keys row: "none" | "claimed" | "bound"
    req,       \* [Reqs -> pc]: "idle" | "claimed" | "inserted" | "done"
    rows,      \* ghost: Pokoin rows committed for the copy
    crLinked,  \* Card Rails attached the listing id
    st,        \* listing status: "none" | "paused" | "active" | "sold_out" | "inactive"
    src,       \* source_listing_id: "" | "pending" | "linked"
    age,       \* ticks since the current claim (saturates at Grace + 1)
    late,      \* a create is still in flight at CardTrader
    live,      \* CardTrader products naming the listing that are for sale
    made,      \* ghost: CardTrader products ever created for the listing
    ordered,   \* a seller order names the listing (it sold on CardTrader)
    hook,      \* order webhook: "none" | "pending" | "done"
    decs,      \* ghost: stock decrements applied for that order
    rc,        \* reconcile: [pc, snapLive, stale]
    pusher,    \* reconcile push step: "idle" | "sending"
    crashes, indoubts, rejects, lost

vars == <<key, req, rows, crLinked, st, src, age, late, live, made, ordered,
          hook, decs, rc, pusher, crashes, indoubts, rejects, lost>>

RcIdle == [pc |-> "idle", snapLive |-> FALSE, stale |-> FALSE]

Init ==
    /\ key = "none" /\ req = [r \in Reqs |-> "idle"] /\ rows = 0
    /\ crLinked = FALSE /\ st = "none" /\ src = "" /\ age = 0 /\ late = FALSE
    /\ live = 0 /\ made = 0 /\ ordered = FALSE /\ hook = "none" /\ decs = 0
    /\ rc = RcIdle /\ pusher = "idle"
    /\ crashes = 0 /\ indoubts = 0 /\ rejects = 0 /\ lost = 0

Keep(vs) == UNCHANGED vs
CtVars   == <<live, made, ordered, hook, decs, late>>

(*************************** Seller API `list` ****************************)
\* The status a new row gets: active when Pokoin quoted a price. On origin
\* the quote read only Pokémon tables, so another game was never quoted.
NewStatus == IF Quoted /\ (Fixed \/ ~OtherGame) THEN "active" ELSE "paused"

\* origin: claim the key; a claimed, unbound key answers list_in_doubt.
\* Fixed: a bound key answers its listing; otherwise claim (on conflict do
\* nothing) and go on, whoever claimed it.
ListStart(r) ==
    /\ req[r] = "idle" /\ ~crLinked
    /\ IF key = "bound"
         THEN /\ crLinked' = TRUE /\ req' = [req EXCEPT ![r] = "done"]
              /\ UNCHANGED key
         ELSE IF Fixed \/ key = "none"
           THEN /\ key' = "claimed" /\ req' = [req EXCEPT ![r] = "claimed"]
                /\ UNCHANGED crLinked
           ELSE UNCHANGED <<key, req, crLinked>>   \* list_in_doubt: Card Rails retries later
    /\ UNCHANGED <<rows, st, src, age, rc, pusher, crashes, indoubts, rejects, lost>>
    /\ Keep(CtVars)

\* origin: the insert commits, then the key is bound in its own statement.
\* Fixed: insert and bind in one transaction, the bind a compare-and-set on
\* an unbound key; losing it rolls the insert back.
ListInsert(r) ==
    /\ req[r] = "claimed"
    /\ IF Fixed
         THEN IF key = "claimed"
                THEN /\ rows' = rows + 1 /\ key' = "bound"
                     /\ st' = IF st = "none" THEN NewStatus ELSE st
                     /\ req' = [req EXCEPT ![r] = "inserted"]
                ELSE /\ req' = [req EXCEPT ![r] = "inserted"]  \* list_key_bound: answer the bound row
                     /\ UNCHANGED <<rows, key, st>>
         ELSE /\ rows' = rows + 1
              /\ st' = IF st = "none" THEN NewStatus ELSE st
              /\ req' = [req EXCEPT ![r] = "inserted"]
              /\ UNCHANGED key
    /\ UNCHANGED <<crLinked, src, age, rc, pusher, crashes, indoubts, rejects, lost>>
    /\ Keep(CtVars)

\* origin binds the key here; both answer the listing to Card Rails.
ListAnswer(r) ==
    /\ req[r] = "inserted"
    /\ key' = "bound"
    /\ crLinked' = TRUE
    /\ req' = [req EXCEPT ![r] = "done"]
    /\ UNCHANGED <<rows, st, src, age, rc, pusher, crashes, indoubts, rejects, lost>>
    /\ Keep(CtVars)

\* The server dies mid-call: the attempt's in-memory state is gone; Card
\* Rails retries the same key on its next sync.
ListCrash(r) ==
    /\ req[r] \in {"claimed", "inserted"} /\ crashes < MaxCrashes
    /\ req' = [req EXCEPT ![r] = "idle"] /\ crashes' = crashes + 1
    /\ UNCHANGED <<key, rows, crLinked, st, src, age, rc, pusher, indoubts, rejects, lost>>
    /\ Keep(CtVars)

\* Card Rails' pull (pokoin_sync.rs `push_local_only_items` re-list guard):
\* exactly one Pokoin listing with the copy's facets and location links the
\* copy without a key. It rescues a row whose answer was lost, never a key
\* claimed with no row.
CrPull ==
    /\ rows = 1 /\ ~crLinked
    /\ crLinked' = TRUE
    /\ UNCHANGED <<key, req, rows, st, src, age, rc, pusher, crashes, indoubts, rejects, lost>>
    /\ Keep(CtVars)

(***************************** Pricing **********************************)
\* A paused, unpriced listing gets a price: Card Rails `update` or the
\* price-unpriced-listings job. origin keeps it paused.
Price ==
    /\ st = "paused" /\ Fixed
    /\ st' = "active"
    /\ UNCHANGED <<key, req, rows, crLinked, src, age, rc, pusher, crashes, indoubts, rejects, lost>>
    /\ Keep(CtVars)

(***************************** CardTrader *******************************)
\* An in-flight create lands (CardTrader applied it after the answer was lost).
CtLand ==
    /\ late
    /\ late' = FALSE /\ live' = live + 1 /\ made' = made + 1
    /\ UNCHANGED <<key, req, rows, crLinked, st, src, age, rc, pusher, ordered, hook, decs,
                   crashes, indoubts, rejects, lost>>

\* A buyer buys the copy on CardTrader: a seller order, a webhook to deliver.
CtSell ==
    /\ live > 0 /\ ~ordered
    /\ live' = live - 1 /\ ordered' = TRUE /\ hook' = "pending"
    /\ UNCHANGED <<key, req, rows, crLinked, st, src, age, late, made, decs, rc, pusher,
                   crashes, indoubts, rejects, lost>>

\* The webhook (webhook.rs) finds the listing by user_data_field, claims the
\* order item once, and decrements; a replay finds the claim (decs stays 1).
HookDeliver ==
    /\ hook \in {"pending", "done"}
    /\ IF hook = "pending"
         THEN /\ decs' = decs + 1
              /\ st' = IF st \in {"active", "paused"} THEN "sold_out" ELSE st
         ELSE UNCHANGED <<decs, st>>
    /\ hook' = "done"
    /\ UNCHANGED <<key, req, rows, crLinked, src, age, late, live, made, ordered, rc, pusher,
                   crashes, indoubts, rejects, lost>>

HookLost ==
    /\ hook = "pending" /\ lost < MaxLostHooks
    /\ hook' = "none" /\ lost' = lost + 1
    /\ UNCHANGED <<key, req, rows, crLinked, st, src, age, late, live, made, ordered, decs, rc,
                   pusher, crashes, indoubts, rejects>>

\* Time passes. A create that is sent (pusher "sending") or in flight at
\* CardTrader (late) lands within Grace ticks of its claim: assumption,
\* STALE_CLAIM_GRACE_SECS (15 min) outlasts the client timeout and any
\* CardTrader create.
Tick ==
    /\ src = "pending" /\ age <= Grace
    /\ ~(LandsInGrace /\ (late \/ pusher = "sending") /\ age = Grace)
    /\ age' = age + 1
    /\ UNCHANGED <<key, req, rows, crLinked, st, src, late, live, made, ordered, hook, decs, rc,
                   pusher, crashes, indoubts, rejects, lost>>

(***************************** Reconcile ********************************)
\* A complete export (push_gate): what is for sale now, and whether the
\* claim is older than the grace when it was taken.
RcExport ==
    /\ rc.pc = "idle" /\ pusher = "idle"
    /\ rc' = [pc |-> "exported", snapLive |-> live > 0,
              stale |-> src = "pending" /\ age > Grace]
    /\ UNCHANGED <<key, req, rows, crLinked, st, src, age, pusher, crashes, indoubts, rejects, lost>>
    /\ Keep(CtVars)

\* plan_inventory_reconcile: a product naming the listing links it
\* (LinkExisting by user_data_field, over a pending claim too). A linked
\* product gone from the export is settled from seller orders: sold out
\* (the sale is recorded once, like the webhook's claim) or delisted.
RcPlan ==
    /\ rc.pc = "exported"
    /\ IF rc.snapLive /\ src # "linked" /\ st \in {"active", "paused"}
         THEN /\ src' = "linked" /\ UNCHANGED <<st, decs, hook>>
         ELSE IF src = "linked" /\ ~rc.snapLive /\ st \in {"active", "paused"}
           THEN /\ st' = IF ordered THEN "sold_out" ELSE "inactive"
                /\ decs' = IF ordered /\ hook # "done" THEN decs + 1 ELSE decs
                /\ hook' = IF ordered THEN "done" ELSE hook
                /\ UNCHANGED src
           ELSE UNCHANGED <<src, st, decs, hook>>
    /\ rc' = [rc EXCEPT !.pc = "planned"]
    /\ UNCHANGED <<key, req, rows, crLinked, age, late, live, made, ordered, pusher,
                   crashes, indoubts, rejects, lost>>

\* Fixed: release_stale_claims. A claim older than the grace at the export,
\* that no exported product and no seller order names, goes back to "".
\* The SQL re-checks the claim, so a newer claim is never released.
\* A stale claim a seller order names sold on CardTrader before any export
\* saw its product: it is settled sold out (the sale counted once), never
\* released, so it is neither listed again nor left for sale on Pokoin.
RcRelease ==
    /\ rc.pc = "planned"
    /\ IF Fixed /\ rc.stale /\ src = "pending" /\ ~rc.snapLive
         THEN IF ~ordered
                THEN /\ src' = "" /\ age' = 0 /\ UNCHANGED <<st, decs, hook>>
                ELSE /\ st' = IF st \in {"active", "paused"} THEN "sold_out" ELSE st
                     /\ decs' = IF hook # "done" /\ st \in {"active", "paused"} THEN decs + 1 ELSE decs
                     /\ hook' = "done"
                     /\ UNCHANGED <<src, age>>
         ELSE UNCHANGED <<src, age, st, decs, hook>>
    /\ rc' = [rc EXCEPT !.pc = "released"]
    /\ UNCHANGED <<key, req, rows, crLinked, pusher, live, made, ordered, late,
                   crashes, indoubts, rejects, lost>>

\* push_unlisted: an active listing with stock and no CardTrader source is
\* claimed ("" -> pending, compare-and-set) and created. origin took only
\* Pokémon listings.
Candidate == st = "active" /\ src = "" /\ (Fixed \/ ~OtherGame)

RcPush ==
    /\ rc.pc = "released"
    /\ IF Candidate
         THEN /\ src' = "pending" /\ age' = 0 /\ pusher' = "sending"
              /\ rc' = [rc EXCEPT !.pc = "pushing"]
         ELSE /\ rc' = RcIdle /\ UNCHANGED <<src, age, pusher>>
    /\ UNCHANGED <<key, req, rows, crLinked, st, crashes, indoubts, rejects, lost>>
    /\ Keep(CtVars)

\* The create's outcome (push::create_with_token_for).
CreateAnswered ==
    /\ pusher = "sending"
    /\ live' = live + 1 /\ made' = made + 1
    \* Linked over our claim; a listing that went off sale meanwhile loses
    \* the product again (destroy), which this model leaves out.
    /\ src' = IF src = "pending" THEN "linked" ELSE src
    /\ pusher' = "idle" /\ rc' = RcIdle
    /\ UNCHANGED <<key, req, rows, crLinked, st, age, late, ordered, hook, decs,
                   crashes, indoubts, rejects, lost>>

CreateRefused ==
    /\ pusher = "sending" /\ rejects < MaxRejects
    /\ src' = IF src = "pending" THEN "" ELSE src   \* RELEASE_SQL: nothing was created
    /\ rejects' = rejects + 1
    /\ pusher' = "idle" /\ rc' = RcIdle
    /\ UNCHANGED <<key, req, rows, crLinked, st, age, crashes, indoubts, lost>>
    /\ Keep(CtVars)

\* No answer or a 5xx: the claim stays. CardTrader made the product, did
\* not, or will make it shortly.
CreateInDoubt ==
    /\ pusher = "sending" /\ indoubts < MaxInDoubt
    /\ \/ /\ live' = live + 1 /\ made' = made + 1 /\ UNCHANGED late
       \/ /\ UNCHANGED <<live, made, late>>
       \/ /\ late' = TRUE /\ UNCHANGED <<live, made>>
    /\ indoubts' = indoubts + 1
    /\ pusher' = "idle" /\ rc' = RcIdle
    /\ UNCHANGED <<key, req, rows, crLinked, st, src, age, ordered, hook, decs,
                   crashes, rejects, lost>>

Next ==
    \/ \E r \in Reqs : ListStart(r) \/ ListInsert(r) \/ ListAnswer(r) \/ ListCrash(r)
    \/ CrPull \/ Price
    \/ CtLand \/ CtSell \/ HookDeliver \/ HookLost \/ Tick
    \/ RcExport \/ RcPlan \/ RcRelease \/ RcPush
    \/ CreateAnswered \/ CreateRefused \/ CreateInDoubt

Spec == Init /\ [][Next]_vars

\* Card Rails keeps retrying; the reconcile runs every ten minutes; time
\* passes; CardTrader answers. Crashes, refusals, lost answers and lost
\* webhooks are bounded, so they cannot happen for ever.
FairSpec ==
    /\ Spec
    /\ \A r \in Reqs : WF_vars(ListStart(r)) /\ WF_vars(ListInsert(r)) /\ WF_vars(ListAnswer(r))
    /\ WF_vars(CrPull) /\ WF_vars(Price) /\ WF_vars(CtLand) /\ WF_vars(Tick)
    /\ WF_vars(RcExport) /\ WF_vars(RcPlan) /\ WF_vars(RcRelease) /\ WF_vars(RcPush)
    /\ WF_vars(CreateAnswered \/ CreateRefused \/ CreateInDoubt)

(***************************** Properties *******************************)
TypeOK ==
    /\ key \in {"none", "claimed", "bound"}
    /\ req \in [Reqs -> {"idle", "claimed", "inserted", "done"}]
    /\ rows \in 0..3 /\ crLinked \in BOOLEAN
    /\ st \in {"none", "paused", "active", "sold_out", "inactive"}
    /\ src \in {"", "pending", "linked"} /\ age \in 0..(Grace + 1)
    /\ late \in BOOLEAN /\ live \in 0..3 /\ made \in 0..3
    /\ ordered \in BOOLEAN /\ hook \in {"none", "pending", "done"} /\ decs \in 0..3
    /\ pusher \in {"idle", "sending"}

\* One Card Rails copy is one Pokoin row, whatever the retries and crashes.
NoDuplicateRow == rows <= 1

\* One Pokoin listing is at most one CardTrader product, ever: an in-doubt
\* create is never followed by a second one while the first may exist or
\* may still land, and a sold copy is never listed again.
NoDuplicateProduct == made <= 1

\* A CardTrader sale takes the stock down once (webhook replay, reconcile
\* settling the same order).
NoDoubleDecrement == decs <= 1

\* Every copy ends up on Pokoin and listed on CardTrader exactly once, or
\* sold there. (Card Rails linked, the listing active and linked to one
\* live product; or sold out.)
Listed ==
    /\ crLinked /\ rows = 1
    /\ \/ st = "active" /\ src = "linked" /\ live = 1
       \/ st = "sold_out"
EventuallyListed == <>[]Listed

Sym == Permutations(Reqs)

\* Witnesses (must be violated in witness/*.cfg: the behaviour is reachable).
NeverReleased == ~(src = "" /\ indoubts > 0 /\ st = "active" /\ made = 0 /\ rc.pc = "released")
NeverListed == ~(st = "active" /\ src = "linked" /\ live = 1 /\ indoubts > 0)
NeverSoldOut == st # "sold_out"
=============================================================================
