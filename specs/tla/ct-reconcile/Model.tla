------------------------------- MODULE Model -------------------------------
(***************************************************************************)
(* CardTrader seller reconcile racing the CardTrader order webhook.         *)
(*                                                                         *)
(* One connected seller. CardTrader (CT) holds products with a quantity;   *)
(* Pokoin holds listings linked to them by source_listing_id = "ct:<id>".  *)
(* Two reconcilers (the API's SyncJobs and the 5-minute timer job, or Pi   *)
(* and the k3s overflow) each fetch /products/export, load the seller's    *)
(* listings, plan (sync_core.rs plan_inventory_reconcile) and then apply   *)
(* the plan one SQL write at a time. CT sales and cancellations reach      *)
(* Pokoin through the webhook (webhook.rs handle_order_payload), whose     *)
(* steps (find, Firestore claim, decrement, merge listingId) interleave     *)
(* with every reconcile write.                                             *)
(*                                                                         *)
(* Fixed = FALSE models origin/main (00bc3d2c); Fixed = TRUE models the     *)
(* code after the fixes recorded in specs/tla/FINDINGS.md.                 *)
(* See README.md for the line-by-line mapping to the Rust code.            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS
    p1, p2,         \* CardTrader products of the seller
    l1, l2, l3,     \* Pokoin listing rows (l1 <-> p1, l2 <-> p2 if linked at start)
    r1, r2,         \* reconcilers
    QtyP1, QtyP2,   \* CardTrader quantity of p1 / p2 at start
    InitLinked,     \* products already linked to a Pokoin listing at start
    MaxSales,       \* bound on CardTrader sales
    MaxCancels,     \* bound on CardTrader cancellations
    MaxDelists,     \* bound on the seller removing a product on CardTrader
    MaxRuns,        \* reconcile runs per reconciler
    MaxLockLoss,    \* times the Redis lock may be lost (TTL expiry / Redis down)
    MaxRedeliver,   \* webhook redeliveries by CardTrader
    ReadModes,      \* how the export parser can read a product (see ReadId)
    MassMin,        \* MASS_REMOVAL_MIN, scaled to the model
    Fixed           \* FALSE = origin/main, TRUE = fixed code

Products    == {p1, p2}
InitQty     == [p \in Products |-> IF p = p1 THEN QtyP1 ELSE QtyP2]
Lids        == {l1, l2, l3}
Reconcilers == {r1, r2}
SaleIds     == 1..MaxSales
Deliveries  == {"paid", "cancel"} \X SaleIds
NoL         == "none"

(* An export row's id as the parser reads it.                              *)
(*   "ok"     the real id                                                  *)
(*   "empty"  the 2026-10-09 class: a numeric id read as ""                *)
(*   "alien"  an id read in the wrong format (e.g. 123.0): non-empty but    *)
(*            not a CardTrader integer id                                  *)
(*   "nogame" id fine but game_id unreadable/unsupported                   *)
(*   "wrong"  a well-formed but wrong id (undetectable by format)           *)
ReadId(p, m) == CASE m = "ok"     -> p
                  [] m = "nogame" -> p
                  [] m = "empty"  -> ""
                  [] m = "alien"  -> <<"alien", p>>
                  [] m = "wrong"  -> <<"wrong", p>>
Ids == Products \cup {<<"alien", p>> : p \in Products} \cup {<<"wrong", p>> : p \in Products}
(* parse_ct_product_id: only "ct:<digits>" is a product id; "wrong" ids are digits. *)
ParsesAsCtId(src) == src \in Products \cup {<<"wrong", p>> : p \in Products}
TrueProduct(src) == IF src \in Products THEN src ELSE "none"

VARIABLES
    ct,         \* [Products -> [qty, live]] CardTrader's truth
    sales,      \* [SaleIds -> [p, st]] st: "none" | "paid" | "cancelled"
    nextSale, cancels, delists,
    lst,        \* [Lids -> [src, qty, st]] marketplace_user_listings
    links,      \* [Ids -> Lids \cup {NoL}] marketplace_cardtrader_product_links
    claims,     \* sale ids with a cardtrader_webhook_events doc
    claimL,     \* [SaleIds -> Lids \cup {NoL}] listingId merged into the event doc
    restored,   \* sale ids whose cancellation was restocked
    saleDocs,   \* [SaleIds -> Nat] marketplace_sales writes per distinct doc id
    whpc,       \* [Deliveries -> state of the webhook handler for that delivery]
    whl,        \* [Deliveries -> listing found]
    redeliver,
    lock, lockLoss,
    rc,         \* [Reconcilers -> reconciler local state]
    acc,        \* ghost: [Lids -> SUBSET SaleIds] sales reflected in the listing qty
    dirty,      \* ghost/fixed: [Reconcilers -> SUBSET Lids] written since the export
    falseDeact, doubleDec, resurrect, doubleRestore, guardBreach, fallback

vars == <<ct, sales, nextSale, cancels, delists, lst, links, claims, claimL,
          restored, saleDocs, whpc, whl, redeliver, lock, lockLoss, rc, acc,
          dirty, falseDeact, doubleDec, resurrect, doubleRestore, guardBreach,
          fallback>>

Status == {"free", "active", "sold_out", "inactive"}
Loaded(l) == lst[l].st \in {"active", "sold_out"}        \* LOAD_SELLER_LISTINGS_SQL
InExport(p) == ct[p].live /\ ct[p].qty > 0

EmptyRc == [pc |-> "idle", runs |-> 0, exp |-> [p \in Products |-> [in |-> FALSE, qty |-> 0, mode |-> "ok"]],
            expSales |-> {}, snap |-> [l \in Lids |-> [src |-> "", qty |-> 0, st |-> "free"]],
            plan |-> <<>>, rem |-> <<>>, orders |-> {}, ordersOk |-> FALSE,
            removed |-> 0, preLinked |-> 0, allow |-> FALSE]

Init ==
    /\ ct = [p \in Products |-> [qty |-> InitQty[p], live |-> TRUE]]
    /\ sales = [s \in SaleIds |-> [p |-> p1, st |-> "none"]]
    /\ nextSale = 1 /\ cancels = 0 /\ delists = 0
    /\ lst = [l \in Lids |-> IF l = l1 /\ p1 \in InitLinked THEN [src |-> p1, qty |-> InitQty[p1], st |-> "active"]
                       ELSE IF l = l2 /\ p2 \in InitLinked THEN [src |-> p2, qty |-> InitQty[p2], st |-> "active"]
                       ELSE [src |-> "", qty |-> 0, st |-> "free"]]
    /\ links = [i \in Ids |-> IF i = p1 /\ p1 \in InitLinked THEN l1
                             ELSE IF i = p2 /\ p2 \in InitLinked THEN l2 ELSE NoL]
    /\ claims = {} /\ claimL = [s \in SaleIds |-> NoL] /\ restored = {}
    /\ saleDocs = [s \in SaleIds |-> 0]
    /\ whpc = [d \in Deliveries |-> "none"] /\ whl = [d \in Deliveries |-> NoL]
    /\ redeliver = 0
    /\ lock = "none" /\ lockLoss = 0
    /\ rc = [r \in Reconcilers |-> EmptyRc]
    /\ acc = [l \in Lids |-> {}]
    /\ dirty = [r \in Reconcilers |-> {}]
    /\ falseDeact = FALSE /\ doubleDec = FALSE /\ resurrect = FALSE
    /\ doubleRestore = FALSE /\ guardBreach = FALSE /\ fallback = 0

(* Every listing write bumps updated_at: mark it dirty for reconcilers whose  *)
(* export was fetched before this write.                                      *)
Touch(l) == dirty' = [r \in Reconcilers |->
                        IF rc[r].pc \in {"load", "plan", "apply", "orders", "remove"}
                        THEN dirty[r] \cup {l} ELSE dirty[r]]

PaidSalesOf(p) == {s \in SaleIds : sales[s].st = "paid" /\ sales[s].p = p}

(*************************** CardTrader side ******************************)
CtSale(p) ==
    /\ nextSale <= MaxSales /\ ct[p].live /\ ct[p].qty > 0
    /\ ct' = [ct EXCEPT ![p].qty = @ - 1]
    /\ sales' = [sales EXCEPT ![nextSale] = [p |-> p, st |-> "paid"]]
    /\ whpc' = [whpc EXCEPT ![<<"paid", nextSale>>] = "queued"]
    /\ nextSale' = nextSale + 1
    /\ UNCHANGED <<cancels, delists, lst, links, claims, claimL, restored, saleDocs,
                   whl, redeliver, lock, lockLoss, rc, acc, dirty, falseDeact,
                   doubleDec, resurrect, doubleRestore, guardBreach, fallback>>

CtCancel(s) ==
    /\ cancels < MaxCancels /\ sales[s].st = "paid" /\ ct[sales[s].p].live
    /\ sales' = [sales EXCEPT ![s].st = "cancelled"]
    /\ ct' = [ct EXCEPT ![sales[s].p].qty = @ + 1]
    /\ whpc' = [whpc EXCEPT ![<<"cancel", s>>] = "queued"]
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<nextSale, delists, lst, links, claims, claimL, restored, saleDocs,
                   whl, redeliver, lock, lockLoss, rc, acc, dirty, falseDeact,
                   doubleDec, resurrect, doubleRestore, guardBreach, fallback>>

CtDelist(p) ==
    /\ delists < MaxDelists /\ ct[p].live
    /\ ct' = [ct EXCEPT ![p].live = FALSE]
    /\ delists' = delists + 1
    /\ UNCHANGED <<sales, nextSale, cancels, lst, links, claims, claimL, restored,
                   saleDocs, whpc, whl, redeliver, lock, lockLoss, rc, acc, dirty,
                   falseDeact, doubleDec, resurrect, doubleRestore, guardBreach, fallback>>

(* CardTrader retries a delivery it already sent. *)
Redeliver(d) ==
    /\ redeliver < MaxRedeliver /\ whpc[d] = "done"
    /\ whpc' = [whpc EXCEPT ![d] = "queued"]
    /\ redeliver' = redeliver + 1
    /\ UNCHANGED <<ct, sales, nextSale, cancels, delists, lst, links, claims, claimL,
                   restored, saleDocs, whl, lock, lockLoss, rc, acc, dirty, falseDeact,
                   doubleDec, resurrect, doubleRestore, guardBreach, fallback>>

(****************************** Webhook ***********************************)
WhUnchanged == UNCHANGED <<ct, sales, nextSale, cancels, delists, redeliver, lock,
                           lockLoss, rc, falseDeact, resurrect, guardBreach>>

(* find_linked_listing: ct:<id> source among active rows, else the links table. *)
Linkable(p) == {l \in Lids : lst[l].src = p /\ lst[l].st = "active"}
LinkedVia(p) == IF links[p] # NoL /\ lst[links[p]].st = "active" THEN {links[p]} ELSE {}

WhFind(s) ==
    LET d == <<"paid", s>> IN
    /\ whpc[d] = "queued"
    /\ IF Linkable(sales[s].p) \cup LinkedVia(sales[s].p) = {}
       THEN \* no_linked_listing -> retrySync (Fixed: enqueue the fallback reconcile)
            /\ whpc' = [whpc EXCEPT ![d] = "done"]
            /\ fallback' = IF Fixed THEN fallback + 1 ELSE fallback
            /\ UNCHANGED whl
       ELSE \E l \in (IF Linkable(sales[s].p) # {} THEN Linkable(sales[s].p) ELSE LinkedVia(sales[s].p)) :
            /\ whl' = [whl EXCEPT ![d] = l]
            /\ whpc' = [whpc EXCEPT ![d] = "found"]
            /\ UNCHANGED fallback
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, acc, dirty,
                   doubleDec, doubleRestore>>
    /\ WhUnchanged

WhClaim(s) ==
    LET d == <<"paid", s>> IN
    /\ whpc[d] = "found"
    /\ IF s \in claims
       THEN whpc' = [whpc EXCEPT ![d] = "done"] /\ UNCHANGED claims  \* already_processed
       ELSE whpc' = [whpc EXCEPT ![d] = "claimed"] /\ claims' = claims \cup {s}
    /\ UNCHANGED <<lst, links, claimL, restored, saleDocs, whl, acc, dirty,
                   doubleDec, doubleRestore, fallback>>
    /\ WhUnchanged

(* DECREMENT_SQL: status active/paused and quantity_available >= qty. *)
WhDecrement(s) ==
    LET d == <<"paid", s>>
        l == whl[d] IN
    /\ whpc[d] = "claimed"
    /\ IF lst[l].st = "active" /\ lst[l].qty >= 1
       THEN /\ lst' = [lst EXCEPT ![l].qty = @ - 1,
                                  ![l].st = IF lst[l].qty - 1 <= 0 THEN "sold_out" ELSE @]
            /\ doubleDec' = (doubleDec \/ s \in acc[l])
            /\ acc' = [acc EXCEPT ![l] = @ \cup {s}]
            /\ Touch(l)
            /\ whpc' = [whpc EXCEPT ![d] = "decremented"]
            /\ UNCHANGED <<claims, fallback>>
       ELSE \* decrement_failed: release the claim, retrySync
            /\ claims' = claims \ {s}
            /\ whpc' = [whpc EXCEPT ![d] = "done"]
            /\ fallback' = IF Fixed THEN fallback + 1 ELSE fallback
            /\ UNCHANGED <<lst, acc, dirty, doubleDec>>
    /\ UNCHANGED <<links, claimL, restored, saleDocs, whl, doubleRestore>>
    /\ WhUnchanged

(* merge listingId into the event doc + record_cardtrader_sale (merge by doc id). *)
WhRecord(s) ==
    LET d == <<"paid", s>> IN
    /\ whpc[d] = "decremented"
    /\ claimL' = [claimL EXCEPT ![s] = whl[d]]
    /\ saleDocs' = [saleDocs EXCEPT ![s] = 1]
    /\ whpc' = [whpc EXCEPT ![d] = "done"]
    /\ UNCHANGED <<lst, links, claims, restored, whl, acc, dirty, doubleDec,
                   doubleRestore, fallback>>
    /\ WhUnchanged

(* restore_cancelled_item: merge_doc_if(no restoredAt, listingId set), then +qty. *)
WhCancelClaim(s) ==
    LET d == <<"cancel", s>> IN
    /\ whpc[d] = "queued"
    /\ IF s \in claims /\ claimL[s] # NoL /\ s \notin restored
       THEN /\ restored' = restored \cup {s}
            /\ whl' = [whl EXCEPT ![d] = claimL[s]]
            /\ whpc' = [whpc EXCEPT ![d] = "restoring"]
       ELSE /\ whpc' = [whpc EXCEPT ![d] = "done"]   \* nothing_to_restore
            /\ UNCHANGED <<restored, whl>>
    /\ UNCHANGED <<lst, links, claims, claimL, saleDocs, acc, dirty, doubleDec,
                   doubleRestore, fallback>>
    /\ WhUnchanged

WhRestore(s) ==
    LET d == <<"cancel", s>>
        l == whl[d] IN
    /\ whpc[d] = "restoring"
    /\ lst' = [lst EXCEPT ![l].qty = @ + 1, ![l].st = IF @ = "sold_out" THEN "active" ELSE @]
    /\ doubleRestore' = (doubleRestore \/ s \notin acc[l])
    /\ acc' = [acc EXCEPT ![l] = @ \ {s}]
    /\ Touch(l)
    /\ whpc' = [whpc EXCEPT ![d] = "done"]
    /\ UNCHANGED <<links, claims, claimL, restored, saleDocs, whl, doubleDec, fallback>>
    /\ WhUnchanged

(***************************** Reconciler *********************************)
RcUnchangedCt == UNCHANGED <<ct, sales, nextSale, cancels, delists, whpc, whl,
                             redeliver, doubleDec, doubleRestore, fallback>>

(* async_sync.rs acquire: Redis SET NX EX 900 (None when another owner holds it). *)
Start(r) ==
    /\ rc[r].pc = "idle" /\ rc[r].runs < MaxRuns /\ lock = "none"
    /\ lock' = r
    /\ rc' = [rc EXCEPT ![r].pc = "fetch"]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lockLoss, acc,
                   dirty, falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

(* The 15-minute TTL expires mid-run (no renewal), or Redis is unreachable and *)
(* acquire() hands out a degraded lock: another reconciler may start.         *)
LoseLock ==
    /\ lock # "none" /\ lockLoss < MaxLockLoss
    /\ lock' = "none" /\ lockLoss' = lockLoss + 1
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, rc, acc, dirty,
                   falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

FetchFailed(r) ==       \* fetch_products_export Err: return, destructiveSkipped
    /\ rc[r].pc = "fetch"
    /\ rc' = [rc EXCEPT ![r].pc = "done"]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lock, lockLoss,
                   acc, dirty, falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

Fetch(r) ==
    /\ rc[r].pc = "fetch"
    /\ \E m \in [Products -> ReadModes] :
         rc' = [rc EXCEPT ![r].pc = "load",
                          ![r].exp = [p \in Products |-> [in |-> InExport(p), qty |-> ct[p].qty, mode |-> m[p]]],
                          ![r].expSales = {s \in SaleIds : sales[s].st = "paid"}]
    /\ dirty' = [dirty EXCEPT ![r] = {}]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lock, lockLoss,
                   acc, falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

Load(r) ==
    /\ rc[r].pc = "load"
    /\ rc' = [rc EXCEPT ![r].pc = "plan",
                        ![r].snap = [l \in Lids |-> IF Loaded(l) THEN lst[l]
                                                    ELSE [src |-> "", qty |-> 0, st |-> "free"]]]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lock, lockLoss,
                   acc, dirty, falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

(* ---- plan_inventory_reconcile (sync_core.rs) as a pure function ---- *)
\* by_source_id: one row per distinct ct: source (HashMap insert, last wins).
BySource(snap, src) == CHOOSE l \in Lids : snap[l].st # "free" /\ snap[l].src = src
SnapSources(snap) == {snap[l].src : l \in {k \in Lids : snap[k].st # "free" /\ snap[k].src \in Ids}}

PlanOf(r) ==
    LET e == rc[r].exp
        snap == rc[r].snap
        rows == {p \in Products : e[p].in}                       \* export array rows
        \* normalize_product + filter(id non-empty); Fixed: only real CT ids parse
        valid(p) == IF Fixed THEN e[p].mode \in {"ok", "nogame", "wrong"}
                             ELSE e[p].mode # "empty"
        normalized == {p \in rows : valid(p)}
        supported == {p \in normalized : e[p].mode # "nogame"}
        \* seen_product_ids: origin/main only adds supported products
        seen == IF Fixed THEN {ReadId(p, e[p].mode) : p \in normalized}
                         ELSE {ReadId(p, e[p].mode) : p \in supported}
        linkedSrc == SnapSources(snap)
        updates == {p \in supported : ReadId(p, e[p].mode) \in linkedSrc
                                       /\ snap[BySource(snap, ReadId(p, e[p].mode))].qty # e[p].qty}
        imports == {p \in supported : ReadId(p, e[p].mode) \notin linkedSrc}
        unparsed == IF Fixed THEN rows # normalized
                             ELSE rows # {} /\ normalized = {}
        cands == {src \in linkedSrc : ParsesAsCtId(src) /\ src \notin seen}
        nrem == Cardinality(cands)
        \* mass_removal_guard: origin/main divides by by_source_id.len() after
        \* imports were inserted; Fixed divides by the pre-run linked listings.
        total == IF Fixed THEN Cardinality(linkedSrc)
                          ELSE Cardinality(linkedSrc \cup {ReadId(p, e[p].mode) : p \in imports})
        blocked == nrem > MassMin /\ 2 * nrem > total
        allow == ~unparsed /\ ~blocked
    IN [updates |-> updates, imports |-> imports, allow |-> allow,
        removals |-> IF allow THEN cands ELSE {}, preLinked |-> Cardinality(linkedSrc)]

SetToSeq(S) == LET f[T \in SUBSET S] == IF T = {} THEN <<>>
                                         ELSE LET x == CHOOSE x \in T : TRUE
                                              IN <<x>> \o f[T \ {x}]
               IN f[S]

Plan(r) ==
    /\ rc[r].pc = "plan"
    /\ LET pl == PlanOf(r)
           e == rc[r].exp
           snap == rc[r].snap
           ups == [i \in 1..Cardinality(pl.updates) |->
                    LET p == SetToSeq(pl.updates)[i] IN
                    [k |-> "update", p |-> p, l |-> BySource(snap, ReadId(p, e[p].mode)), q |-> e[p].qty, src |-> ReadId(p, e[p].mode)]]
           ims == [i \in 1..Cardinality(pl.imports) |->
                    LET p == SetToSeq(pl.imports)[i] IN
                    [k |-> IF Fixed THEN "import_atomic" ELSE "import_find",
                     p |-> p, l |-> NoL, q |-> e[p].qty, src |-> ReadId(p, e[p].mode)]]
           rems == [i \in 1..Cardinality(pl.removals) |->
                    LET src == SetToSeq(pl.removals)[i] IN
                    [k |-> "remove", p |-> TrueProduct(src), l |-> BySource(snap, src), q |-> 0, src |-> src]]
       IN rc' = [rc EXCEPT ![r].pc = "apply", ![r].plan = ups \o ims, ![r].rem = rems,
                           ![r].allow = pl.allow, ![r].preLinked = pl.preLinked]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lock, lockLoss,
                   acc, dirty, falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

FreeLid == CHOOSE l \in Lids : lst[l].st = "free"
HasFree == \E l \in Lids : lst[l].st = "free"
ExistingBySource(src) == {l \in Lids : lst[l].st # "free" /\ lst[l].src = src}

(* create_imported_listing found a row for this source: a hidden (inactive)   *)
(* row whose link is missing_from_ct is re-activated (REACTIVATE_HIDDEN_SQL);  *)
(* any other row is returned unchanged. Removal is the only path to inactive  *)
(* here and it always marks the link missing_from_ct.                        *)
Reactivate(r, a) ==
    LET l == CHOOSE k \in ExistingBySource(a.src) : TRUE IN
    IF lst[l].st = "inactive"
    THEN /\ lst' = [lst EXCEPT ![l].st = "active", ![l].qty = a.q]
         /\ links' = [links EXCEPT ![a.src] = l]
         /\ acc' = [acc EXCEPT ![l] = {s \in rc[r].expSales : sales[s].p = a.p}]
         /\ Touch(l)
    ELSE UNCHANGED <<lst, links, acc, dirty>>

(* apply_ct_quantity (APPLY_CT_QUANTITY_SQL): absolute CT quantity.          *)
(* Fixed: never raise the quantity of a row written after the export fetch. *)
ApplyQty(r, l, q) ==
    LET grows == q > lst[l].qty
        skip == Fixed /\ grows /\ l \in dirty[r]
        reflected == {s \in rc[r].expSales : sales[s].p = lst[l].src}
    IN IF skip THEN UNCHANGED <<lst, acc, resurrect, dirty>>
       ELSE /\ lst' = [lst EXCEPT ![l].qty = q,
                                  ![l].st = IF q <= 0 /\ @ # "inactive" THEN "sold_out"
                                            ELSE IF @ = "sold_out" THEN "active" ELSE @]
            \* ghost: the write undoes a real, already-applied sale decrement
            /\ resurrect' = (resurrect \/ (grows /\ \E s \in acc[l] : s \notin reflected /\ sales[s].st = "paid"))
            /\ acc' = [acc EXCEPT ![l] = reflected]
            /\ Touch(l)

ApplyStep(r) ==
    /\ rc[r].pc = "apply" /\ rc[r].plan # <<>>
    /\ LET a == Head(rc[r].plan) IN
       CASE a.k = "update" ->
              /\ ApplyQty(r, a.l, a.q)
              /\ rc' = [rc EXCEPT ![r].plan = Tail(@)]
              /\ UNCHANGED <<links>>
         [] a.k = "import_find" ->       \* FIND_EXISTING_BY_SOURCE_SQL (separate statement)
              /\ IF ExistingBySource(a.src) = {}
                 THEN /\ rc' = [rc EXCEPT ![r].plan = <<[a EXCEPT !.k = "import_insert"]>> \o Tail(@)]
                      /\ UNCHANGED <<lst, links, acc, dirty>>
                 ELSE /\ Reactivate(r, a)
                      /\ rc' = [rc EXCEPT ![r].plan = Tail(@)]
              /\ UNCHANGED resurrect
         [] a.k = "import_insert" ->     \* CREATE_IMPORTED_LISTING_SQL + upsert link
              /\ HasFree
              /\ lst' = [lst EXCEPT ![FreeLid] = [src |-> a.src, qty |-> a.q, st |-> "active"]]
              /\ links' = [links EXCEPT ![a.src] = FreeLid]
              /\ acc' = [acc EXCEPT ![FreeLid] = {s \in rc[r].expSales : sales[s].p = a.p}]
              /\ Touch(FreeLid)
              /\ rc' = [rc EXCEPT ![r].plan = Tail(@)]
              /\ UNCHANGED resurrect
         [] a.k = "import_atomic" ->     \* Fixed: advisory xact lock + find + insert
              /\ IF ExistingBySource(a.src) = {}
                 THEN /\ HasFree
                      /\ lst' = [lst EXCEPT ![FreeLid] = [src |-> a.src, qty |-> a.q, st |-> "active"]]
                      /\ links' = [links EXCEPT ![a.src] = FreeLid]
                      /\ acc' = [acc EXCEPT ![FreeLid] = {s \in rc[r].expSales : sales[s].p = a.p}]
                      /\ Touch(FreeLid)
                 ELSE Reactivate(r, a)
              /\ rc' = [rc EXCEPT ![r].plan = Tail(@)]
              /\ UNCHANGED resurrect
    /\ UNCHANGED <<claims, claimL, restored, saleDocs, lock, lockLoss, falseDeact, guardBreach>>
    /\ RcUnchangedCt

ApplyDone(r) ==
    /\ rc[r].pc = "apply" /\ rc[r].plan = <<>>
    /\ rc' = [rc EXCEPT ![r].pc = IF rc[r].allow /\ rc[r].rem # <<>> THEN "orders" ELSE "done"]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lock, lockLoss,
                   acc, dirty, falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

(* fetch_seller_orders for sale evidence; Err => every verdict is Unknown. *)
Orders(r) ==
    /\ rc[r].pc = "orders"
    /\ \E ok \in BOOLEAN :
         rc' = [rc EXCEPT ![r].pc = "remove", ![r].ordersOk = ok,
                          ![r].orders = {s \in SaleIds : sales[s].st = "paid"}]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lock, lockLoss,
                   acc, dirty, falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

(* Destructive pass: classify_vanished_product, then Sold => qty 0 + claim the *)
(* missed sales; Delisted/Unknown => delist_ct_listing (inactive).            *)
Remove(r) ==
    /\ rc[r].pc = "remove" /\ rc[r].rem # <<>>
    /\ LET a == Head(rc[r].rem)
           l == a.l
           sold == {s \in rc[r].orders : rc[r].ordersOk /\ sales[s].p = a.p}
           present == a.p \in Products /\ rc[r].exp[a.p].in
       IN /\ IF sold # {}
             THEN /\ lst' = [lst EXCEPT ![l].qty = 0, ![l].st = IF @ = "inactive" THEN @ ELSE "sold_out"]
                  /\ claims' = claims \cup sold
                  /\ claimL' = [s \in SaleIds |-> IF s \in sold /\ s \notin claims THEN l ELSE claimL[s]]
                  /\ saleDocs' = [s \in SaleIds |-> IF s \in sold /\ s \notin claims THEN 1 ELSE saleDocs[s]]
             ELSE /\ lst' = IF lst[l].st \in {"active", "sold_out"}
                            THEN [lst EXCEPT ![l].qty = 0, ![l].st = "inactive"] ELSE lst
                  /\ UNCHANGED <<claims, claimL, saleDocs>>
          /\ falseDeact' = (falseDeact \/ present)
          /\ acc' = [acc EXCEPT ![l] = {}]
          /\ links' = [links EXCEPT ![a.src] = l]
          /\ Touch(l)
          /\ rc' = [rc EXCEPT ![r].rem = Tail(@), ![r].removed = @ + 1]
    /\ UNCHANGED <<restored, lock, lockLoss, resurrect, guardBreach>>
    /\ RcUnchangedCt

RemoveDone(r) ==
    /\ rc[r].pc = "remove" /\ rc[r].rem = <<>>
    /\ rc' = [rc EXCEPT ![r].pc = "done"]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lock, lockLoss,
                   acc, dirty, falseDeact, resurrect, guardBreach>>
    /\ RcUnchangedCt

(* record_seller_sync, then release_lock (owner-checked compare-and-delete). *)
Finish(r) ==
    /\ rc[r].pc = "done"
    /\ guardBreach' = (guardBreach \/ (rc[r].removed > MassMin /\ 2 * rc[r].removed > rc[r].preLinked))
    /\ lock' = IF lock = r THEN "none" ELSE lock
    /\ rc' = [rc EXCEPT ![r] = [EmptyRc EXCEPT !.runs = rc[r].runs + 1]]
    /\ dirty' = [dirty EXCEPT ![r] = {}]
    /\ UNCHANGED <<lst, links, claims, claimL, restored, saleDocs, lockLoss, acc,
                   falseDeact, resurrect>>
    /\ RcUnchangedCt

Next ==
    \/ \E p \in Products : CtSale(p) \/ CtDelist(p)
    \/ \E s \in SaleIds : CtCancel(s) \/ WhFind(s) \/ WhClaim(s) \/ WhDecrement(s)
                          \/ WhRecord(s) \/ WhCancelClaim(s) \/ WhRestore(s)
    \/ \E d \in Deliveries : Redeliver(d)
    \/ LoseLock
    \/ \E r \in Reconcilers :
         \/ Start(r) \/ FetchFailed(r) \/ Fetch(r) \/ Load(r) \/ Plan(r)
         \/ ApplyStep(r) \/ ApplyDone(r) \/ Orders(r) \/ Remove(r) \/ RemoveDone(r)
         \/ Finish(r)

Spec == Init /\ [][Next]_vars

Sym == Permutations(Reconcilers)

(******************************* Properties *******************************)
TypeOK ==
    /\ \A l \in Lids : lst[l].st \in Status /\ lst[l].qty \in Nat
    /\ claims \subseteq SaleIds
    /\ lock \in Reconcilers \cup {"none"}

\* Quantity never goes negative.
NonNegative == \A l \in Lids : lst[l].qty >= 0

\* A listing whose CardTrader product is present in a complete export is
\* never deactivated (an export read as empty/garbled cannot remove stock).
NoFalseDeactivation == ~falseDeact

\* No run removes more than mass_removal_guard allows, measured against the
\* listings that were linked before the run.
GuardBound == ~guardBreach

\* A sale is recorded (marketplace_sales) at most once.
NoDoubleCount == \A s \in SaleIds : saleDocs[s] <= 1

\* A sale is never decremented twice from Pokoin stock.
NoDoubleDecrement == ~doubleDec

\* A stale export never resurrects stock a webhook already took away.
NoStaleResurrection == ~resurrect

\* A cancellation never restocks a sale that was not taken off the listing.
NoDoubleRestore == ~doubleRestore

\* At most one live Pokoin listing per CardTrader product (no duplicate imports).
LiveFor(l, p) == /\ lst[l].st \in {"active", "sold_out"}
                 /\ lst[l].src \in {p, <<"alien", p>>}
UniqueLink == \A p \in Products : Cardinality({l \in Lids : LiveFor(l, p)}) <= 1
(* Witnesses (must be VIOLATED by the fixed model: the behaviour is reachable). *)
NeverDelists == \A l \in Lids : lst[l].st # "inactive"
NeverImports == lst[l2].st = "free" /\ lst[l3].st = "free"
NeverWebhookSale == \A s \in SaleIds : saleDocs[s] = 0
NeverQuantityUpdate == \A r \in Reconcilers : rc[r].plan = <<>> \/ Head(rc[r].plan).k # "update"

=============================================================================
