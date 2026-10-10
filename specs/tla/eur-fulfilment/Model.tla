------------------------------- MODULE Model -------------------------------
(***************************************************************************)
(* EUR (Stripe) marketplace orders: reservation, payment, release and      *)
(* fulfilment, all racing.                                                 *)
(*                                                                         *)
(* An order reserves stock at checkout (orders.rs                          *)
(* create_order_checkout_session: listing decrement + checkout hold). The  *)
(* buyer pays or abandons the Stripe Checkout session. The Stripe webhook  *)
(* (stripe.rs) marks it paid and fulfils it, or releases it on expiry. The *)
(* buyer can cancel (order_cancel). The 5-minute sweep (jobs/eur.rs)       *)
(* releases stale unpaid orders, recovers paid sessions whose webhook was  *)
(* lost, and resumes half-done fulfilments. fulfil_paid_eur_order takes a  *)
(* 10-minute Firestore lease, commits or re-takes the inventory (conflict  *)
(* => needs_refund), drops the hold, decrements seller ownership, buys     *)
(* CardTrader live lines through the shared Pokoin CardTrader cart, and    *)
(* records the outcome. Any process can die at any step.                   *)
(*                                                                         *)
(* Fixed = FALSE models origin/main (00bc3d2c); Fixed = TRUE the code after *)
(* the fixes in specs/tla/FINDINGS.md. README.md maps actions to the code.  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS
    o1, o2,          \* orders
    fw, fs,          \* fulfil callers: the API (webhook/cancel) and the sweep job
    Kind,            \* [Orders -> {"native", "ct"}]: Pokoin listing or CardTrader live line
    Stock,           \* units on the Pokoin listing all native lines buy from
    Pays,            \* orders whose buyer may pay
    MaxCrashes,      \* process deaths / failed Firestore or SQL calls
    MaxBuyDoubt,     \* CardTrader purchases whose answer is lost
    MaxLeaseExpiry,  \* fulfilment leases (10 min) that expire under a live worker
    MaxRedeliver,    \* Stripe webhook redeliveries
    Fixed

Orders  == {o1, o2}
\* Line mixes for Kind (cfg: Kind <- AllNative).
AllNative == [o \in {o1, o2} |-> "native"]
AllCt     == [o \in {o1, o2} |-> "ct"]
Callers == {fw, fs}
PaidLike == {"paid"}
Releasable == {"pending_stripe", "expired", "cancelled", "failed"}

VARIABLES
    pay,      \* paymentStatus
    st,       \* top-level status
    fst,      \* fulfillmentStatus
    inv,      \* inventory.state
    ful,      \* fulfillment.state
    lease,    \* [Orders -> [owner, live, orphan]] fulfillment "running" lease of one call
    disc,     \* pknDiscount.state: "held" | "released" | "consumed"
    sess,     \* Stripe Checkout session: "open" | "complete" | "expired"
    ev,       \* [Orders -> [completed, expired]] Stripe events to deliver
    claimed,  \* Stripe event ids claimed (stripe_event:<id>)
    stock,    \* listing quantity_available
    hold,     \* [Orders -> 0..1] marketplace_checkout_holds rows
    ownDone,  \* fulfillment.ownershipDone
    buyDone,  \* fulfillment.cardtrader buy:<listing> complete
    marker,   \* cardtrader_purchase_markers status
    cart,     \* the Pokoin CardTrader cart (shared)
    cartLock, \* Fixed: owner of the cart lock
    pc,       \* [Callers -> fulfil state]
    hp,       \* [Orders -> webhook/cancel/sweep handler state]
    \* ghosts
    taken, restored, returned, consumed, purchases, ownDec,
    crashes, buyDoubt, expiries, redeliver

vars == <<pay, st, fst, inv, ful, lease, disc, sess, ev, claimed, stock, hold,
          ownDone, buyDone, marker, cart, cartLock, pc, hp, taken, restored,
          returned, consumed, purchases, ownDec, crashes, buyDoubt, expiries,
          redeliver>>

Idle == [s |-> "idle", o |-> o1, seen |-> "none", fail |-> FALSE]
NoH  == [s |-> "idle", kind |-> "none"]

(* create_order_checkout_session: the hold and the decrement are taken     *)
(* before the order exists; native orders that find no stock never exist.  *)
NativeOrders == {o \in Orders : Kind[o] = "native"}
Init ==
    /\ \E made \in SUBSET Orders :
         /\ \A o \in Orders : Kind[o] = "ct" => o \in made
         /\ Cardinality({o \in made : Kind[o] = "native"}) <= Stock
         /\ pay = [o \in Orders |-> IF o \in made THEN "pending_stripe" ELSE "none"]
         /\ hold = [o \in Orders |-> IF o \in made /\ Kind[o] = "native" THEN 1 ELSE 0]
         /\ stock = Stock - Cardinality({o \in made : Kind[o] = "native"})
         /\ taken = [o \in Orders |-> IF o \in made /\ Kind[o] = "native" THEN 1 ELSE 0]
         /\ inv = [o \in Orders |-> IF o \in made THEN "reserved" ELSE "none"]
         /\ sess = [o \in Orders |-> IF o \in made THEN "open" ELSE "none"]
    /\ st = [o \in Orders |-> "pending"] /\ fst = [o \in Orders |-> "none"]
    /\ ful = [o \in Orders |-> "pending"]
    /\ lease = [o \in Orders |-> [owner |-> "none", live |-> FALSE, orphan |-> FALSE]]
    /\ disc = [o \in Orders |-> "held"]
    /\ ev = [o \in Orders |-> [completed |-> 0, expired |-> 0]]
    /\ claimed = {}
    /\ ownDone = [o \in Orders |-> FALSE] /\ buyDone = [o \in Orders |-> FALSE]
    /\ marker = [o \in Orders |-> "none"] /\ cart = {} /\ cartLock = "none"
    /\ pc = [c \in Callers |-> Idle] /\ hp = [o \in Orders |-> NoH]
    /\ restored = [o \in Orders |-> 0] /\ returned = [o \in Orders |-> 0]
    /\ consumed = [o \in Orders |-> 0] /\ purchases = [o \in Orders |-> 0]
    /\ ownDec = [o \in Orders |-> 0]
    /\ crashes = 0 /\ buyDoubt = 0 /\ expiries = 0 /\ redeliver = 0

Ghosts == <<taken, restored, returned, consumed, purchases, ownDec, crashes, buyDoubt, expiries, redeliver>>
Exists(o) == pay[o] # "none"

(******************************** Stripe **********************************)
Pay(o) ==            \* the buyer completes Checkout
    /\ o \in Pays /\ sess[o] = "open"
    /\ sess' = [sess EXCEPT ![o] = "complete"]
    /\ ev' = [ev EXCEPT ![o].completed = 1]
    /\ UNCHANGED <<pay, st, fst, inv, ful, lease, disc, claimed, stock, hold, ownDone,
                   buyDone, marker, cart, cartLock, pc, hp>> /\ UNCHANGED Ghosts

StripeExpire(o) ==   \* expires_at passed (31 min), or POST .../expire succeeded
    /\ sess[o] = "open"
    /\ sess' = [sess EXCEPT ![o] = "expired"]
    /\ ev' = [ev EXCEPT ![o].expired = 1]
    /\ UNCHANGED <<pay, st, fst, inv, ful, lease, disc, claimed, stock, hold, ownDone,
                   buyDone, marker, cart, cartLock, pc, hp>> /\ UNCHANGED Ghosts

(* Stripe retries a delivery whose handler failed. *)
Redeliver(o, k) ==
    /\ redeliver < MaxRedeliver /\ ev[o][k] = 2
    /\ ev' = [ev EXCEPT ![o][k] = 1]
    /\ redeliver' = redeliver + 1
    /\ UNCHANGED <<pay, st, fst, inv, ful, lease, disc, sess, claimed, stock, hold, ownDone,
                   buyDone, marker, cart, cartLock, pc, hp>>
    /\ UNCHANGED <<taken, restored, returned, consumed, purchases, ownDec, crashes, buyDoubt, expiries>>

(**************************** Release (shared) ****************************)
(* release_eur_reservation, Firestore transaction: release_plan. *)
ReleaseTxn(o, status, extra) ==
    /\ pay[o] \in Releasable \cup extra
    /\ pay' = [pay EXCEPT ![o] = status]
    /\ st' = [st EXCEPT ![o] = "cancelled"]
    /\ fst' = [fst EXCEPT ![o] = "cancelled"]
    /\ inv' = IF inv[o] = "reserved" THEN [inv EXCEPT ![o] = "released"] ELSE inv
    /\ disc' = IF disc[o] = "held" THEN [disc EXCEPT ![o] = "released"] ELSE disc
    /\ returned' = IF disc[o] = "held" THEN [returned EXCEPT ![o] = @ + 1] ELSE returned

(* release_order_stock: delete the hold rows and restore what they held, in *)
(* one statement: only the deleter restores.                               *)
ReleaseStock(o) ==
    /\ stock' = stock + hold[o]
    /\ restored' = [restored EXCEPT ![o] = @ + hold[o]]
    /\ hold' = [hold EXCEPT ![o] = 0]

(************************* Stripe webhook / cancel ************************)
(* Handler states per order: "w_completed" -> "w_patch" -> fulfil call;   *)
(* "w_expired" -> "r_stock"; "c_*" buyer cancel; "s_*" sweep.             *)
HUnchanged == UNCHANGED <<ful, lease, ownDone, buyDone, marker, cart, cartLock>>

Deliver(o, k) ==
    /\ hp[o].s = "idle" /\ ev[o][k] = 1
    /\ ev' = [ev EXCEPT ![o][k] = 2]
    /\ IF <<o, k>> \in claimed      \* stripe_event:<id> already claimed: duplicate, 200
       THEN UNCHANGED <<claimed, hp>>
       ELSE /\ claimed' = claimed \cup {<<o, k>>}
            /\ hp' = [hp EXCEPT ![o] = [s |-> IF k = "completed" THEN "w_completed" ELSE "w_expired", kind |-> "web"]]
    /\ UNCHANGED <<pay, st, fst, inv, disc, sess, stock, hold, pc>> /\ HUnchanged /\ UNCHANGED Ghosts

(* handle_marketplace_order_paid: read the order; paid already => fulfil;  *)
(* else set paymentStatus paid, consume the PKN discount, then fulfil.     *)
WebhookPaid(o) ==
    /\ hp[o].s = "w_completed"
    /\ IF pay[o] = "paid"
       THEN /\ hp' = [hp EXCEPT ![o].s = "call_fulfil"]
            /\ UNCHANGED <<pay, st, disc, consumed>>
       ELSE /\ pay' = [pay EXCEPT ![o] = "paid"] /\ st' = [st EXCEPT ![o] = "paid"]
            /\ disc' = [disc EXCEPT ![o] = "consumed"]
            /\ consumed' = [consumed EXCEPT ![o] = @ + 1]
            /\ hp' = [hp EXCEPT ![o].s = "call_fulfil"]
    /\ UNCHANGED <<fst, inv, sess, ev, claimed, stock, hold, pc>> /\ HUnchanged
    /\ UNCHANGED <<taken, restored, returned, purchases, ownDec, crashes, buyDoubt, expiries, redeliver>>

WebhookExpired(o) ==
    /\ hp[o].s = "w_expired"
    /\ IF pay[o] \in Releasable
       THEN /\ ReleaseTxn(o, "expired", {})
            /\ hp' = [hp EXCEPT ![o].s = "r_stock"]
       ELSE /\ hp' = [hp EXCEPT ![o] = NoH]
            /\ UNCHANGED <<pay, st, fst, inv, disc, returned>>
    /\ UNCHANGED <<sess, ev, claimed, stock, hold, pc>> /\ HUnchanged
    /\ UNCHANGED <<taken, restored, consumed, purchases, ownDec, crashes, buyDoubt, expiries, redeliver>>

RestoreStock(o) ==
    /\ hp[o].s = "r_stock"
    /\ ReleaseStock(o)
    /\ hp' = [hp EXCEPT ![o] = NoH]
    /\ UNCHANGED <<pay, st, fst, inv, disc, sess, ev, claimed, pc>> /\ HUnchanged
    /\ UNCHANGED <<taken, returned, consumed, purchases, ownDec, crashes, buyDoubt, expiries, redeliver>>

(* order_cancel. origin/main releases pending_stripe / processing /        *)
(* expired / failed orders while the Checkout session may still be paid.   *)
(* Fixed (Node's cancelPendingEurOrder): only pending_stripe; expire the   *)
(* session first; a session Stripe already completed is recovered as paid. *)
Cancel(o) ==
    /\ hp[o].s = "idle" /\ Exists(o)
    /\ IF ~Fixed
       THEN /\ pay[o] \in {"pending_stripe", "processing", "expired", "failed"}
            /\ ReleaseTxn(o, "cancelled", {"processing"})
            /\ hp' = [hp EXCEPT ![o] = [s |-> "r_stock", kind |-> "cancel"]]
            /\ UNCHANGED sess
       ELSE /\ pay[o] = "pending_stripe"
            /\ IF sess[o] = "complete"
               THEN \* expire fails, the session is paid: onPaid (409 already_paid)
                    /\ hp' = [hp EXCEPT ![o] = [s |-> "w_completed", kind |-> "cancel"]]
                    /\ UNCHANGED <<pay, st, fst, inv, disc, returned, sess>>
               ELSE /\ sess' = [sess EXCEPT ![o] = "expired"]
                    /\ ReleaseTxn(o, "cancelled", {})
                    /\ hp' = [hp EXCEPT ![o] = [s |-> "r_stock", kind |-> "cancel"]]
    /\ ev' = IF Fixed /\ sess[o] = "open" /\ pay[o] = "pending_stripe"
             THEN [ev EXCEPT ![o].expired = 1] ELSE ev
    /\ UNCHANGED <<claimed, stock, hold, pc>> /\ HUnchanged
    /\ UNCHANGED <<taken, restored, consumed, purchases, ownDec, crashes, buyDoubt, expiries, redeliver>>

(********************************* Sweep **********************************)
(* jobs/eur.rs sweep, pending_stripe orders past their hold:               *)
(* paid session => recover_paid (transaction: paid_plan) then fulfil;      *)
(* open session => POST /expire (fails once complete) then release.        *)
SweepPending(o) ==
    /\ hp[o].s = "idle" /\ pay[o] = "pending_stripe"
    /\ IF sess[o] = "complete"
       THEN /\ pay' = [pay EXCEPT ![o] = "paid"] /\ st' = [st EXCEPT ![o] = "paid"]
            /\ disc' = IF disc[o] = "held" THEN [disc EXCEPT ![o] = "consumed"] ELSE disc
            /\ consumed' = IF disc[o] = "held" THEN [consumed EXCEPT ![o] = @ + 1] ELSE consumed
            /\ hp' = [hp EXCEPT ![o] = [s |-> "call_fulfil", kind |-> "sweep"]]
            /\ UNCHANGED <<fst, inv, returned, sess>>
       ELSE /\ sess' = [sess EXCEPT ![o] = "expired"]
            /\ ReleaseTxn(o, "expired", {})
            /\ hp' = [hp EXCEPT ![o] = [s |-> "r_stock", kind |-> "sweep"]]
            /\ UNCHANGED consumed
    /\ ev' = IF sess[o] = "open" THEN [ev EXCEPT ![o].expired = 1] ELSE ev
    /\ UNCHANGED <<claimed, stock, hold, pc>> /\ HUnchanged
    /\ UNCHANGED <<taken, restored, purchases, ownDec, crashes, buyDoubt, expiries, redeliver>>

(* A handler that reached its fulfil call hands the order to a caller. *)
Caller(o) == IF hp[o].kind = "sweep" THEN fs ELSE fw
CallFulfil(o) ==
    /\ hp[o].s = "call_fulfil" /\ pc[Caller(o)].s = "idle"
    /\ pc' = [pc EXCEPT ![Caller(o)] = [Idle EXCEPT !.s = "lease", !.o = o]]
    /\ hp' = [hp EXCEPT ![o] = NoH]
    /\ UNCHANGED <<pay, st, fst, inv, disc, sess, ev, claimed, stock, hold>> /\ HUnchanged /\ UNCHANGED Ghosts

(* Sweep: unfinished = fulfillment.state in [running, partial]. Fixed also *)
(* resumes a paid order whose fulfilment never took its lease.             *)
SweepResume(o) ==
    /\ pc[fs].s = "idle"
    /\ \/ ful[o] \in {"running", "partial"}
       \/ Fixed /\ pay[o] \in PaidLike /\ ful[o] = "pending"
    /\ pc' = [pc EXCEPT ![fs] = [Idle EXCEPT !.s = "lease", !.o = o]]
    /\ UNCHANGED <<pay, st, fst, inv, disc, sess, ev, claimed, stock, hold, hp>> /\ HUnchanged /\ UNCHANGED Ghosts

(*************************** fulfil_paid_eur_order *************************)
FUnchangedOrder == UNCHANGED <<pay, st, disc, sess, ev, claimed, hp>>
Go(c, s) == pc' = [pc EXCEPT ![c].s = s]

(* Firestore transaction: skip unless paid, not done/conflict, no live lease. *)
Lease(c) ==
    LET o == pc[c].o IN
    /\ pc[c].s = "lease"
    /\ IF pay[o] \notin PaidLike \/ ful[o] \in {"done", "conflict"} \/ (ful[o] = "running" /\ lease[o].live)
       THEN /\ pc' = [pc EXCEPT ![c] = Idle] /\ UNCHANGED <<ful, lease>>
       ELSE /\ ful' = [ful EXCEPT ![o] = "running"]
            /\ lease' = [lease EXCEPT ![o] = [owner |-> c, live |-> TRUE, orphan |-> FALSE]]
            /\ pc' = [pc EXCEPT ![c].s = "inv", ![c].seen = inv[o], ![c].fail = FALSE]
    /\ UNCHANGED <<fst, inv, stock, hold, ownDone, buyDone, marker, cart, cartLock>>
    /\ FUnchangedOrder /\ UNCHANGED Ghosts

(* Inventory: committed => nothing; reserved => commit; otherwise re-take  *)
(* (verify_and_decrement_listings with the order's hold). origin/main      *)
(* decrements again even when this order already holds the unit (hold     *)
(* upsert); Fixed inserts the hold first and decrements only if inserted. *)
Inv(c) ==
    LET o == pc[c].o IN
    /\ pc[c].s = "inv"
    /\ CASE pc[c].seen = "committed" ->
              Go(c, "lines") /\ UNCHANGED <<stock, hold, inv, ful, fst, taken>>
         [] pc[c].seen = "reserved" ->
              Go(c, "commit") /\ UNCHANGED <<stock, hold, inv, ful, fst, taken>>
         [] Kind[o] = "ct" ->            \* live CardTrader listing still there?
              \/ Go(c, "commit") /\ UNCHANGED <<stock, hold, inv, ful, fst, taken>>
              \/ /\ inv' = [inv EXCEPT ![o] = "conflict"] /\ ful' = [ful EXCEPT ![o] = "conflict"]
                 /\ fst' = [fst EXCEPT ![o] = "needs_refund"]
                 /\ pc' = [pc EXCEPT ![c] = Idle] /\ UNCHANGED <<stock, hold, taken>>
         [] Fixed /\ hold[o] > 0 ->      \* already taken by an earlier attempt
              Go(c, "commit") /\ UNCHANGED <<stock, hold, inv, ful, fst, taken>>
         [] stock > 0 ->
              /\ stock' = stock - 1 /\ hold' = [hold EXCEPT ![o] = 1]
              /\ taken' = [taken EXCEPT ![o] = @ + 1]
              /\ Go(c, "commit") /\ UNCHANGED <<inv, ful, fst>>
         [] OTHER ->                       \* conflict => needs_refund
              /\ inv' = [inv EXCEPT ![o] = "conflict"] /\ ful' = [ful EXCEPT ![o] = "conflict"]
              /\ fst' = [fst EXCEPT ![o] = "needs_refund"]
              /\ pc' = [pc EXCEPT ![c] = Idle] /\ UNCHANGED <<stock, hold, taken>>
    /\ UNCHANGED <<lease, ownDone, buyDone, marker, cart, cartLock>>
    /\ FUnchangedOrder /\ UNCHANGED <<restored, returned, consumed, purchases, ownDec, crashes, buyDoubt, expiries, redeliver>>

Commit(c) ==     \* set_document inventory.state = committed
    LET o == pc[c].o IN
    /\ pc[c].s = "commit"
    /\ inv' = [inv EXCEPT ![o] = "committed"]
    /\ Go(c, "lines")
    /\ UNCHANGED <<fst, ful, lease, stock, hold, ownDone, buyDone, marker, cart, cartLock>>
    /\ FUnchangedOrder /\ UNCHANGED Ghosts

(* Native line not linked to CardTrader: drop_eur_hold (no restore). *)
DropHold(c) ==
    LET o == pc[c].o IN
    /\ pc[c].s = "lines"
    /\ hold' = IF Kind[o] = "native" THEN [hold EXCEPT ![o] = 0] ELSE hold
    /\ Go(c, IF Kind[o] = "native" /\ ~ownDone[o] THEN "own" ELSE "buy")
    /\ UNCHANGED <<fst, inv, ful, lease, stock, ownDone, buyDone, marker, cart, cartLock>>
    /\ FUnchangedOrder /\ UNCHANGED Ghosts

(* decrement_seller_ownership_for_sale, then ownershipDone is written.     *)
(* Fixed: the decrement and its per-order marker are one transaction.      *)
Own(c) ==
    LET o == pc[c].o IN
    /\ pc[c].s = "own"
    /\ IF Fixed
       THEN /\ ownDec' = IF ownDone[o] THEN ownDec ELSE [ownDec EXCEPT ![o] = @ + 1]
            /\ ownDone' = [ownDone EXCEPT ![o] = TRUE]
            /\ Go(c, "buy")
       ELSE /\ ownDec' = [ownDec EXCEPT ![o] = @ + 1]
            /\ Go(c, "ownmark") /\ UNCHANGED ownDone
    /\ UNCHANGED <<fst, inv, ful, lease, stock, hold, buyDone, marker, cart, cartLock>>
    /\ FUnchangedOrder /\ UNCHANGED <<taken, restored, returned, consumed, purchases, crashes, buyDoubt, expiries, redeliver>>
OwnMark(c) ==
    LET o == pc[c].o IN
    /\ pc[c].s = "ownmark"
    /\ ownDone' = [ownDone EXCEPT ![o] = TRUE]
    /\ Go(c, "buy")
    /\ UNCHANGED <<fst, inv, ful, lease, stock, hold, buyDone, marker, cart, cartLock>>
    /\ FUnchangedOrder /\ UNCHANGED Ghosts

(* ---- CardTrader buy-through (cardtrader_adapter.rs buy_through) ---- *)
BUnchanged == UNCHANGED <<fst, inv, ful, lease, stock, hold, ownDone>>
Fail(c, s) == pc' = [pc EXCEPT ![c].s = s, ![c].fail = TRUE]

Buy(c) ==        \* steps.cardtrader_buy not done and buy:<listing> not complete
    LET o == pc[c].o IN
    /\ pc[c].s = "buy"
    /\ Go(c, IF Kind[o] = "ct" /\ ~buyDone[o] THEN (IF Fixed THEN "b_lock" ELSE "b_claim") ELSE "final")
    /\ BUnchanged /\ UNCHANGED <<buyDone, marker, cart, cartLock>> /\ FUnchangedOrder /\ UNCHANGED Ghosts

(* Fixed: one buy-through at a time per Pokoin CardTrader account. *)
BLock(c) ==
    /\ pc[c].s = "b_lock"
    /\ IF cartLock = "none"
       THEN cartLock' = c /\ Go(c, "b_claim")
       ELSE UNCHANGED cartLock /\ Fail(c, "final")       \* busy: retried later
    /\ BUnchanged /\ UNCHANGED <<buyDone, marker, cart>> /\ FUnchangedOrder /\ UNCHANGED Ghosts

Unlock(c) == cartLock' = IF cartLock = c THEN "none" ELSE cartLock

(* Marker transaction: purchased/applied/skipped => complete; claimed or   *)
(* cart_added (Fixed: also purchase_unknown) => busy; else claim it.       *)
BClaim(c) ==
    LET o == pc[c].o IN
    /\ pc[c].s = "b_claim"
    /\ CASE marker[o] = "purchased" ->
              buyDone' = [buyDone EXCEPT ![o] = TRUE] /\ Go(c, "b_unlock") /\ UNCHANGED marker
         [] marker[o] \in {"claimed", "cart_added", "purchase_unknown"} ->
              Fail(c, "b_unlock") /\ UNCHANGED <<marker, buyDone>>
         [] OTHER ->
              marker' = [marker EXCEPT ![o] = "claimed"] /\ Go(c, "b_cart") /\ UNCHANGED buyDone
    /\ BUnchanged /\ UNCHANGED <<cart, cartLock>> /\ FUnchangedOrder /\ UNCHANGED Ghosts

BCart(c) ==      \* refuse a non-empty cart
    LET o == pc[c].o IN
    /\ pc[c].s = "b_cart"
    /\ IF cart # {}
       THEN marker' = [marker EXCEPT ![o] = "blocked_non_empty_cart"] /\ Fail(c, "b_unlock")
       ELSE Go(c, "b_add") /\ UNCHANGED marker
    /\ BUnchanged /\ UNCHANGED <<buyDone, cart, cartLock>> /\ FUnchangedOrder /\ UNCHANGED Ghosts

BAdd(c) ==       \* POST /cart/add, then marker cart_added
    LET o == pc[c].o IN
    /\ pc[c].s = "b_add"
    /\ cart' = cart \cup {o}
    /\ marker' = [marker EXCEPT ![o] = "cart_added"]
    /\ Go(c, "b_purchase")
    /\ BUnchanged /\ UNCHANGED <<buyDone, cartLock>> /\ FUnchangedOrder /\ UNCHANGED Ghosts

(* POST /cart/purchase buys everything in the cart. An empty cart is an    *)
(* error answer; a lost answer leaves the purchase done but unknown.       *)
(* origin/main marks any error "failed", which the next claim re-acquires; *)
(* Fixed marks an error after the purchase was sent "purchase_unknown".    *)
BPurchase(c) ==
    LET o == pc[c].o
        errMark == IF Fixed THEN "purchase_unknown" ELSE "failed" IN
    /\ pc[c].s = "b_purchase"
    /\ \/ /\ cart # {}
          /\ purchases' = [i \in Orders |-> IF i \in cart THEN purchases[i] + 1 ELSE purchases[i]]
          /\ cart' = {}
          /\ Go(c, "b_mark") /\ UNCHANGED <<marker, buyDoubt>>
       \/ /\ cart # {} /\ buyDoubt < MaxBuyDoubt
          /\ purchases' = [i \in Orders |-> IF i \in cart THEN purchases[i] + 1 ELSE purchases[i]]
          /\ cart' = {}
          /\ buyDoubt' = buyDoubt + 1
          /\ marker' = [marker EXCEPT ![o] = errMark] /\ Fail(c, "b_unlock")
       \/ /\ cart = {}
          /\ marker' = [marker EXCEPT ![o] = errMark] /\ Fail(c, "b_unlock")
          /\ UNCHANGED <<purchases, cart, buyDoubt>>
    /\ BUnchanged /\ UNCHANGED <<buyDone, cartLock>> /\ FUnchangedOrder
    /\ UNCHANGED <<taken, restored, returned, consumed, ownDec, crashes, expiries, redeliver>>

BMark(c) ==
    LET o == pc[c].o IN
    /\ pc[c].s = "b_mark"
    /\ marker' = [marker EXCEPT ![o] = "purchased"]
    /\ buyDone' = [buyDone EXCEPT ![o] = TRUE]
    /\ Go(c, "b_unlock")
    /\ BUnchanged /\ UNCHANGED <<cart, cartLock>> /\ FUnchangedOrder /\ UNCHANGED Ghosts

BUnlock(c) ==
    /\ pc[c].s = "b_unlock"
    /\ Unlock(c) /\ Go(c, "final")
    /\ BUnchanged /\ UNCHANGED <<buyDone, marker, cart>> /\ FUnchangedOrder /\ UNCHANGED Ghosts

(* Final set_document: done or partial; fulfillmentStatus awaiting_shipment *)
(* only if empty/pending (origin/main), Fixed also over a stale "cancelled".*)
Final(c) ==
    LET o == pc[c].o IN
    /\ pc[c].s = "final"
    /\ ful' = [ful EXCEPT ![o] = IF pc[c].fail THEN "partial" ELSE "done"]
    /\ fst' = IF fst[o] \in {"none", "pending"} \/ (Fixed /\ fst[o] = "cancelled")
              THEN [fst EXCEPT ![o] = "awaiting_shipment"] ELSE fst
    /\ pc' = [pc EXCEPT ![c] = Idle]
    /\ UNCHANGED <<inv, lease, stock, hold, ownDone, buyDone, marker, cart, cartLock>>
    /\ FUnchangedOrder /\ UNCHANGED Ghosts

(******************************** Faults **********************************)
(* A fulfil call dies (process crash, a failed Firestore/SQL call). Its    *)
(* lease stays "running" until it expires; a held cart lock expires too.   *)
CrashFulfil(c) ==
    /\ pc[c].s # "idle" /\ crashes < MaxCrashes
    /\ pc' = [pc EXCEPT ![c] = Idle]
    /\ cartLock' = IF cartLock = c THEN "none" ELSE cartLock
    /\ lease' = IF lease[pc[c].o].owner = c /\ lease[pc[c].o].live
                THEN [lease EXCEPT ![pc[c].o].orphan = TRUE] ELSE lease
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<pay, st, fst, inv, ful, disc, sess, ev, claimed, stock, hold,
                   ownDone, buyDone, marker, cart, hp>>
    /\ UNCHANGED <<taken, restored, returned, consumed, purchases, ownDec, buyDoubt, expiries, redeliver>>

(* A handler dies after claiming its Stripe event (or between a release's  *)
(* transaction and its stock restore).                                     *)
CrashHandler(o) ==
    /\ hp[o].s # "idle" /\ crashes < MaxCrashes
    /\ hp' = [hp EXCEPT ![o] = NoH]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<pay, st, fst, inv, ful, lease, disc, sess, ev, claimed, stock, hold,
                   ownDone, buyDone, marker, cart, cartLock, pc>>
    /\ UNCHANGED <<taken, restored, returned, consumed, purchases, ownDec, buyDoubt, expiries, redeliver>>

(* The 10-minute lease runs out: always for a dead owner; under a live,    *)
(* slow owner only MaxLeaseExpiry times.                                   *)
LeaseExpire(o) ==
    /\ ful[o] = "running" /\ lease[o].live
    /\ IF lease[o].orphan THEN UNCHANGED expiries
       ELSE expiries < MaxLeaseExpiry /\ expiries' = expiries + 1
    /\ lease' = [lease EXCEPT ![o].live = FALSE]
    /\ UNCHANGED <<pay, st, fst, inv, ful, disc, sess, ev, claimed, stock, hold, ownDone,
                   buyDone, marker, cart, cartLock, pc, hp>>
    /\ UNCHANGED <<taken, restored, returned, consumed, purchases, ownDec, crashes, buyDoubt, redeliver>>

FulfilStep(c) == Lease(c) \/ Inv(c) \/ Commit(c) \/ DropHold(c) \/ Own(c) \/ OwnMark(c)
                 \/ Buy(c) \/ BLock(c) \/ BClaim(c) \/ BCart(c) \/ BAdd(c) \/ BPurchase(c)
                 \/ BMark(c) \/ BUnlock(c) \/ Final(c)
HandlerStep(o) == WebhookPaid(o) \/ WebhookExpired(o) \/ RestoreStock(o) \/ CallFulfil(o)

Next ==
    \/ \E o \in Orders :
         \/ Pay(o) \/ StripeExpire(o) \/ Cancel(o) \/ SweepPending(o) \/ SweepResume(o)
         \/ HandlerStep(o) \/ CrashHandler(o) \/ LeaseExpire(o)
         \/ \E k \in {"completed", "expired"} : Deliver(o, k) \/ Redeliver(o, k)
    \/ \E c \in Callers : FulfilStep(c) \/ CrashFulfil(c)

Spec == Init /\ [][Next]_vars

FairSpec == /\ Spec
            /\ \A c \in Callers : WF_vars(FulfilStep(c))
            /\ \A o \in Orders : WF_vars(HandlerStep(o)) /\ WF_vars(SweepResume(o))
                                 /\ WF_vars(SweepPending(o)) /\ WF_vars(LeaseExpire(o))
                                 /\ \A k \in {"completed", "expired"} : WF_vars(Deliver(o, k))

(******************************* Properties *******************************)
TypeOK ==
    /\ \A o \in Orders : hold[o] \in 0..1 /\ inv[o] \in {"none", "reserved", "released", "committed", "conflict"}
    /\ stock \in 0..Stock /\ cartLock \in Callers \cup {"none"}

\* Stock is reserved at most once per order line, and given back at most once.
ReserveOnce == \A o \in Orders : taken[o] - restored[o] \in {0, 1} /\ restored[o] <= taken[o]

\* A fulfilled native order holds its unit (it was not released and resold).
FulfilledHoldsStock == \A o \in NativeOrders :
    ful[o] = "done" => taken[o] - restored[o] = 1

\* An order is never both cancelled/expired and fulfilled.
NotReleasedAndFulfilled == \A o \in Orders :
    ful[o] = "done" => fst[o] # "cancelled" /\ st[o] # "cancelled"

\* The PKN discount is returned or consumed, never both.
DiscountOnce == \A o \in Orders : returned[o] + consumed[o] <= 1

\* A CardTrader buy-through is executed at most once per line.
BuyOnce == \A o \in Orders : purchases[o] <= 1

\* The seller's ownership row loses a sold unit once.
OwnershipOnce == \A o \in Orders : ownDec[o] <= 1

Terminal(o) == ful[o] \in {"done", "conflict"} \/ fst[o] = "needs_refund"

\* Liveness: a paid order eventually ends done, conflict or needs_refund.
PaidEventuallyTerminal == \A o \in Orders : pay[o] = "paid" ~> Terminal(o)
(* Witnesses (must be VIOLATED by the fixed model: the behaviour is reachable). *)
NeverFulfilled == \A o \in Orders : ful[o] # "done"
NeverReleased == \A o \in Orders : restored[o] = 0
NeverBought == \A o \in Orders : purchases[o] = 0
NeverPartial == \A o \in Orders : ful[o] # "partial"

=============================================================================
