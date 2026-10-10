------------------------------- MODULE Model -------------------------------
(***************************************************************************)
(* The listings outbox sync engine for one seller listing L.               *)
(*                                                                         *)
(* HTTP mutations (handlers/listings.rs) write the listing and enqueue a    *)
(* listing.changed event in the same writer transaction, then bump the     *)
(* read-cache generations. API instances (Pi, k3s overflow) drain the      *)
(* outbox (listing_sync.rs drain_once): CLAIM_SQL leases the lowest        *)
(* pending id for 30 s and counts an attempt, apply_event runs its steps   *)
(* (price refresh, generation bumps, live publish, CardTrader push+link,   *)
(* CardTrader destroy), and the row is marked processed. A worker can die  *)
(* or error at any step; a lease can expire under a slow worker. The Pi    *)
(* read replica lags the writer and feeds the read cache (read_cache.rs).  *)
(*                                                                         *)
(* Fixed = FALSE models origin/main (00bc3d2c); Fixed = TRUE models the     *)
(* code after the fixes in specs/tla/FINDINGS.md. README.md maps each      *)
(* action to the Rust code.                                                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS
    w1, w2,             \* API instances draining the outbox
    MaxUpdates,         \* seller mutations after the create (update/deactivate)
    MaxAttempts,        \* CLAIM_SQL attempts < 8, scaled
    MaxCrashes,         \* worker deaths or apply errors
    MaxAmbiguous,       \* CardTrader creates whose response is lost
    MaxRejects,         \* CardTrader creates rejected outright
    MaxDestroyFailures, \* CardTrader DELETE /products failures (5xx, timeout)
    MaxFills,           \* read-cache fills
    MaxReplicaTimeouts, \* Fixed: replica waits that give up and bump anyway
    SlowWorkers,        \* TRUE: a lease may expire under a live worker
    LinkedDeactivate,   \* scenario: deactivate only a linked, replicated listing
    Fixed

Workers   == {w1, w2}
SellerEvents == 1 + MaxUpdates
MaxEvents == SellerEvents + 1    \* + one compensation event (Fixed)
Events    == 1..MaxEvents
Products  == {"ct1", "ct2"} \* CardTrader product ids the model can create
NoP       == "none"
Pending(e) == "ct:pending:" \o ToString(e)
Srcs      == {""} \cup Products \cup {Pending(e) : e \in Events}
IsCt(src) == src \in Products   \* "ct:<digits>": destroy_product acts on it

VARIABLES
    lst,       \* writer row: [ex, st, src, ver]
    rep,       \* Pi replica copy of the row
    ob,        \* [Events -> outbox row]
    nev,       \* events enqueued
    reqBump,   \* versions whose request-path generation bump is pending
    wk,        \* [Workers -> in-memory drain state]
    ct,        \* [Products -> "none" | "live" | "destroyed"]
    pushes,    \* ghost: [Events -> CardTrader creates issued for that event]
    gen,       \* card generation (Redis INCR)
    syncedVer, \* ghost: newest version whose consumer bump ran
    cache,     \* [g, v]: the cached card page (generation, row version read)
    fill,      \* in-flight fill: [busy, g, v]
    mirror,    \* [Products -> BOOLEAN] a reconcile-imported active listing exists
    crashes, ambiguous, rejects, fills, timeouts, dfails

vars == <<lst, rep, ob, nev, reqBump, wk, ct, pushes, gen, syncedVer, cache,
          fill, mirror, crashes, ambiguous, rejects, fills, timeouts, dfails>>

NoRow == [ex |-> FALSE, st |-> "none", src |-> "", ver |-> 0]
IdleW == [pc |-> "idle", e |-> 0, src |-> "", pid |-> NoP]
NoEv  == [state |-> "none", attempts |-> 0, leased |-> FALSE, kind |-> "none",
          ver |-> 0, wantsCT |-> FALSE, destroyCT |-> FALSE, src |-> ""]

Init ==
    /\ lst = NoRow /\ rep = NoRow
    /\ ob = [e \in Events |-> NoEv] /\ nev = 0 /\ reqBump = {}
    /\ wk = [w \in Workers |-> IdleW]
    /\ ct = [p \in Products |-> "none"] /\ pushes = [e \in Events |-> 0]
    /\ gen = 0 /\ syncedVer = 0
    /\ cache = [g |-> 0, v |-> 0] /\ fill = [busy |-> FALSE, g |-> 0, v |-> 0]
    /\ mirror = [p \in Products |-> FALSE]
    /\ crashes = 0 /\ ambiguous = 0 /\ rejects = 0 /\ fills = 0 /\ timeouts = 0
    /\ dfails = 0

Enqueue(row) ==
    /\ ob' = [ob EXCEPT ![nev + 1] = row]
    /\ nev' = nev + 1

(****************************** HTTP mutations ****************************)
(* create_listing with targets.cardtrader: insert + event in one tx.       *)
CreateListing ==
    /\ ~lst.ex /\ nev = 0
    /\ lst' = [ex |-> TRUE, st |-> "active", src |-> "", ver |-> 1]
    /\ Enqueue([NoEv EXCEPT !.state = "pending", !.kind = "create", !.ver = 1, !.wantsCT = TRUE])
    /\ reqBump' = reqBump \cup {1}
    /\ UNCHANGED <<rep, wk, ct, pushes, gen, syncedVer, cache, fill, mirror, crashes,
                   ambiguous, rejects, fills, timeouts, dfails>>

(* update_listing (price/quantity): the event carries the written row. *)
UpdateListing ==
    /\ lst.ex /\ rep.ex /\ nev < SellerEvents
    /\ lst' = [lst EXCEPT !.ver = @ + 1]
    /\ Enqueue([NoEv EXCEPT !.state = "pending", !.kind = "update", !.ver = lst.ver + 1, !.src = lst.src])
    /\ reqBump' = reqBump \cup {lst.ver + 1}
    /\ UNCHANGED <<rep, wk, ct, pushes, gen, syncedVer, cache, fill, mirror, crashes,
                   ambiguous, rejects, fills, timeouts, dfails>>

(* update_listing status=inactive. origin/main decides destroyCardtrader   *)
(* from `existing`, read from the Pi replica before the transaction; the   *)
(* fixed code uses the row the writer returned.                            *)
DeactivateListing ==
    /\ lst.ex /\ rep.ex /\ lst.st = "active" /\ nev < SellerEvents
    /\ LinkedDeactivate => IsCt(rep.src)
    /\ LET seen == IF Fixed THEN lst.src ELSE rep.src
           src  == IF seen # "" THEN seen ELSE lst.src     \* sync::event fallback
       IN /\ lst' = [lst EXCEPT !.st = "inactive", !.ver = @ + 1]
          /\ Enqueue([NoEv EXCEPT !.state = "pending", !.kind = "deactivate", !.ver = lst.ver + 1,
                                  !.destroyCT = (seen # ""), !.src = src])
    /\ reqBump' = reqBump \cup {lst.ver + 1}
    /\ UNCHANGED <<rep, wk, ct, pushes, gen, syncedVer, cache, fill, mirror, crashes,
                   ambiguous, rejects, fills, timeouts, dfails>>

(* finish_write: sync::invalidate right after commit. *)
RequestBump(v) ==
    /\ v \in reqBump
    /\ reqBump' = reqBump \ {v}
    /\ gen' = gen + 1
    /\ UNCHANGED <<lst, rep, ob, nev, wk, ct, pushes, syncedVer, cache, fill,
                   mirror, crashes, ambiguous, rejects, fills, timeouts, dfails>>

(* Streaming replication: the replica catches up to the writer. *)
Replicate ==
    /\ rep # lst
    /\ rep' = lst
    /\ UNCHANGED <<lst, ob, nev, reqBump, wk, ct, pushes, gen, syncedVer, cache,
                   fill, mirror, crashes, ambiguous, rejects, fills, timeouts, dfails>>

(* read_cache.rs: read the generation, render from the replica, SET the key. *)
FillStart ==
    /\ ~fill.busy /\ fills < MaxFills
    /\ fill' = [busy |-> TRUE, g |-> gen, v |-> rep.ver]
    /\ fills' = fills + 1
    /\ UNCHANGED <<lst, rep, ob, nev, reqBump, wk, ct, pushes, gen, syncedVer,
                   cache, mirror, crashes, ambiguous, rejects, timeouts, dfails>>
FillEnd ==
    /\ fill.busy
    /\ cache' = [g |-> fill.g, v |-> fill.v]
    /\ fill' = [fill EXCEPT !.busy = FALSE]
    /\ UNCHANGED <<lst, rep, ob, nev, reqBump, wk, ct, pushes, gen, syncedVer,
                   mirror, crashes, ambiguous, rejects, fills, timeouts, dfails>>

(******************************* Outbox drain *****************************)
Claimable(e) == /\ e <= nev /\ ob[e].state = "pending" /\ ~ob[e].leased
                /\ ob[e].attempts < MaxAttempts
WUnchanged == UNCHANGED <<rep, nev, reqBump, fill, fills, ambiguous, rejects, mirror, dfails>>

(* CLAIM_SQL: lowest claimable id; attempts + 1; available_at = now()+30s. *)
Claim(w) ==
    /\ wk[w].pc = "idle"
    /\ \E e \in Events : Claimable(e)
    /\ LET e == CHOOSE x \in Events : Claimable(x) /\ \A y \in Events : Claimable(y) => x <= y IN
       /\ ob' = [ob EXCEPT ![e].leased = TRUE, ![e].attempts = @ + 1]
       /\ wk' = [wk EXCEPT ![w] = [pc |-> "price", e |-> e, src |-> ob[e].src, pid |-> NoP]]
    /\ UNCHANGED <<lst, ct, pushes, gen, syncedVer, cache, crashes, timeouts>>
    /\ WUnchanged

Price(w) ==       \* refresh_price on the writer (idempotent)
    /\ wk[w].pc = "price"
    /\ wk' = [wk EXCEPT ![w].pc = "gen"]
    /\ UNCHANGED <<lst, ob, ct, pushes, gen, syncedVer, cache, crashes, timeouts>>
    /\ WUnchanged

(* INCR card/search generations, then publish_listing. Fixed: first wait  *)
(* until the replica has replayed past the writer LSN seen at the claim.   *)
Gen(w) ==
    /\ wk[w].pc = "gen"
    /\ LET v == ob[wk[w].e].ver IN
       \/ /\ ~Fixed \/ rep.ver >= v
          /\ gen' = gen + 1 /\ syncedVer' = IF v > syncedVer THEN v ELSE syncedVer
          /\ wk' = [wk EXCEPT ![w].pc = "ct"]
          /\ UNCHANGED timeouts
       \/ /\ Fixed /\ rep.ver < v /\ timeouts < MaxReplicaTimeouts
          /\ gen' = gen + 1 /\ syncedVer' = IF v > syncedVer THEN v ELSE syncedVer
          /\ wk' = [wk EXCEPT ![w].pc = "ct"]
          /\ timeouts' = timeouts + 1
    /\ UNCHANGED <<lst, ob, ct, pushes, cache, crashes>>
    /\ WUnchanged

(* wantsCardtrader && steps.cardtrader unset. origin/main: source from the *)
(* payload or the writer row; empty => push_listing(link = true).          *)
(* Fixed (push_cardtrader): claim the push by moving the row from "" to    *)
(* ct:pending:<event>; any other source means pushed already, or a push in *)
(* doubt that the reconcile links by user_data_field.                      *)
CtStep(w) ==
    /\ wk[w].pc = "ct"
    /\ LET e == wk[w].e
           src == IF wk[w].src # "" THEN wk[w].src ELSE lst.src IN
       IF ~ob[e].wantsCT
       THEN /\ wk' = [wk EXCEPT ![w].pc = "destroy"] /\ UNCHANGED lst
       ELSE IF Fixed
       THEN IF wk[w].src = "" /\ lst.src = ""
            THEN /\ lst' = [lst EXCEPT !.src = Pending(e)]
                 /\ wk' = [wk EXCEPT ![w].pc = "create"]
            ELSE /\ wk' = [wk EXCEPT ![w].src = src, ![w].pc = "destroy"]
                 /\ UNCHANGED lst
       ELSE IF src = ""
            THEN /\ wk' = [wk EXCEPT ![w].pc = "create"] /\ UNCHANGED lst
            ELSE /\ wk' = [wk EXCEPT ![w].src = src, ![w].pc = "destroy"] /\ UNCHANGED lst
    /\ UNCHANGED <<ob, nev, ct, pushes, gen, syncedVer, cache, crashes, timeouts>>
    /\ UNCHANGED <<rep, reqBump, fill, fills, ambiguous, rejects, mirror, dfails>>

NextPid == CHOOSE p \in Products : ct[p] = "none"
CanCreate == \E p \in Products : ct[p] = "none"

(* CardTrader POST /products. Ok, rejected (no product), or created with   *)
(* the response lost (timeout): the last two end the attempt with an error.*)
CtCreate(w) ==
    /\ wk[w].pc = "create" /\ CanCreate
    /\ LET e == wk[w].e IN
       \/ /\ ct' = [ct EXCEPT ![NextPid] = "live"]
          /\ pushes' = [pushes EXCEPT ![e] = @ + 1]
          /\ wk' = [wk EXCEPT ![w].pc = "link", ![w].pid = NextPid]
          /\ UNCHANGED <<ambiguous, rejects, lst>>
       \/ /\ ambiguous < MaxAmbiguous
          /\ ct' = [ct EXCEPT ![NextPid] = "live"]
          /\ pushes' = [pushes EXCEPT ![e] = @ + 1]
          /\ wk' = [wk EXCEPT ![w] = IdleW]
          /\ ambiguous' = ambiguous + 1
          /\ UNCHANGED <<rejects, lst>>              \* Fixed: in doubt, keep pending
       \/ /\ rejects < MaxRejects
          /\ wk' = [wk EXCEPT ![w] = IdleW]
          /\ rejects' = rejects + 1
          \* Fixed: a definite rejection releases the push claim for a retry.
          /\ lst' = IF Fixed /\ lst.src = Pending(e) THEN [lst EXCEPT !.src = ""] ELSE lst
          /\ UNCHANGED <<ct, pushes, ambiguous>>
    /\ UNCHANGED <<ob, gen, syncedVer, cache, crashes, timeouts>>
    /\ UNCHANGED <<rep, nev, reqBump, fill, fills, mirror, dfails>>

(* push_and_link: set source_listing_id. Fixed: one writer transaction    *)
(* links over this event's claim only and, if the listing went off sale    *)
(* (or the claim is gone), enqueues a destroy event of its own: the        *)
(* compensation survives this worker, whose lease another may have taken.  *)
Link(w) ==
    /\ wk[w].pc = "link"
    /\ LET e == wk[w].e
           p == wk[w].pid
           ours == lst.src = Pending(e) IN
       IF Fixed
       THEN /\ lst' = IF ours THEN [lst EXCEPT !.src = p] ELSE lst
            /\ IF ~ours \/ lst.st = "inactive"
               THEN /\ nev < MaxEvents
                    /\ Enqueue([NoEv EXCEPT !.state = "pending", !.kind = "compensate", !.ver = lst.ver,
                                            !.destroyCT = TRUE, !.src = p])
               ELSE UNCHANGED <<ob, nev>>
            /\ wk' = [wk EXCEPT ![w].src = p, ![w].pc = "destroy"]
       ELSE /\ lst' = [lst EXCEPT !.src = p]
            /\ wk' = [wk EXCEPT ![w].src = p, ![w].pc = "destroy"]
            /\ UNCHANGED <<ob, nev>>
    /\ UNCHANGED <<ct, pushes, gen, syncedVer, cache, crashes, timeouts>>
    /\ UNCHANGED <<rep, reqBump, fill, fills, ambiguous, rejects, mirror, dfails>>

(* destroy_product: DELETE /products/<id>. A product already gone answers  *)
(* 404 and counts as destroyed: destroying twice is idempotent. A 5xx or a  *)
(* timeout: origin/main logs it and reports success (Node did the same), so *)
(* the step is done and the product stays on sale; Fixed returns the error  *)
(* and the event is retried.                                                *)
DestroyCall(w, src, next) ==
    \/ /\ ct' = IF IsCt(src) /\ ct[src] = "live" THEN [ct EXCEPT ![src] = "destroyed"] ELSE ct
       /\ wk' = [wk EXCEPT ![w].pc = next]
       /\ UNCHANGED dfails
    \/ /\ IsCt(src) /\ ct[src] = "live" /\ dfails < MaxDestroyFailures
       /\ dfails' = dfails + 1
       /\ UNCHANGED ct
       /\ wk' = IF Fixed THEN [wk EXCEPT ![w] = IdleW] ELSE [wk EXCEPT ![w].pc = next]

(* destroyCardtrader && sourceListingId: destroy_product (quantity 0, DELETE). *)
Destroy(w) ==
    /\ wk[w].pc = "destroy"
    /\ IF ob[wk[w].e].destroyCT
       THEN DestroyCall(w, wk[w].src, "finish")
       ELSE /\ wk' = [wk EXCEPT ![w].pc = "finish"] /\ UNCHANGED <<ct, dfails>>
    /\ UNCHANGED <<lst, ob, pushes, gen, syncedVer, cache, crashes, timeouts>>
    /\ UNCHANGED <<rep, nev, reqBump, fill, fills, ambiguous, rejects, mirror>>

Finish(w) ==      \* processed_at = now() by id (no lease check)
    /\ wk[w].pc = "finish"
    /\ ob' = [ob EXCEPT ![wk[w].e].state = "processed", ![wk[w].e].leased = FALSE]
    /\ wk' = [wk EXCEPT ![w] = IdleW]
    /\ UNCHANGED <<lst, ct, pushes, gen, syncedVer, cache, crashes, timeouts>>
    /\ WUnchanged

(* The process dies, or apply_event returns Err (last_error recorded, the  *)
(* claimed payload kept): either way the in-memory steps are lost and the  *)
(* row waits for its lease to expire.                                      *)
Crash(w) ==
    /\ wk[w].pc # "idle" /\ crashes < MaxCrashes
    /\ wk' = [wk EXCEPT ![w] = IdleW]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<lst, ob, ct, pushes, gen, syncedVer, cache, timeouts>>
    /\ WUnchanged

(* available_at passes. With SlowWorkers the holder may still be running. *)
LeaseExpire(e) ==
    /\ e <= nev /\ ob[e].leased /\ ob[e].state = "pending"
    /\ SlowWorkers \/ \A w \in Workers : wk[w].e # e \/ wk[w].pc = "idle"
    /\ ob' = [ob EXCEPT ![e].leased = FALSE]
    /\ UNCHANGED <<lst, rep, nev, reqBump, wk, ct, pushes, gen, syncedVer, cache,
                   fill, mirror, crashes, ambiguous, rejects, fills, timeouts, dfails>>

(* The 5-minute CardTrader reconcile: a live product whose user_data_field *)
(* names L links to L when L is not linked to a CardTrader product yet.    *)
ReconcileLink ==
    /\ lst.ex /\ lst.st = "active" /\ ~IsCt(lst.src)
    /\ \E p \in Products : ct[p] = "live" /\ lst' = [lst EXCEPT !.src = p]
    /\ UNCHANGED <<rep, ob, nev, reqBump, wk, ct, pushes, gen, syncedVer, cache,
                   fill, mirror, crashes, ambiguous, rejects, fills, timeouts, dfails>>

(* The reconcile mirrors a live product no active listing is linked to: the *)
(* import finds no row with source ct:<p> and inserts one. A row that does *)
(* carry ct:<p> but is inactive with a live link is returned unchanged.    *)
ReconcileImport ==
    /\ \E p \in Products :
         /\ ct[p] = "live" /\ ~mirror[p] /\ lst.src # p
         /\ ~(lst.ex /\ lst.st = "active" /\ ~IsCt(lst.src))   \* else ReconcileLink
         /\ mirror' = [mirror EXCEPT ![p] = TRUE]
    /\ UNCHANGED <<lst, rep, ob, nev, reqBump, wk, ct, pushes, gen, syncedVer, cache,
                   fill, crashes, ambiguous, rejects, fills, timeouts, dfails>>

WorkerStep(w) == Claim(w) \/ Price(w) \/ Gen(w) \/ CtStep(w) \/ CtCreate(w) \/ Link(w)
                 \/ Destroy(w) \/ Finish(w)

Next ==
    \/ CreateListing \/ UpdateListing \/ DeactivateListing
    \/ \E v \in reqBump : RequestBump(v)
    \/ Replicate \/ FillStart \/ FillEnd \/ ReconcileLink \/ ReconcileImport
    \/ \E w \in Workers : WorkerStep(w) \/ Crash(w)
    \/ \E e \in Events : LeaseExpire(e)

Spec == Init /\ [][Next]_vars

FairSpec == /\ Spec
            /\ \A w \in Workers : WF_vars(WorkerStep(w))
            /\ \A e \in Events : WF_vars(LeaseExpire(e))
            /\ WF_vars(Replicate) /\ WF_vars(ReconcileLink) /\ WF_vars(ReconcileImport)
            /\ \A v \in 1..(MaxEvents + 1) : WF_vars(RequestBump(v))

Sym == Permutations(Workers)

(******************************* Properties *******************************)
TypeOK ==
    /\ lst.src \in Srcs /\ rep.src \in Srcs
    /\ \A w \in Workers : wk[w].pc \in {"idle", "price", "gen", "ct", "create", "link",
                                       "destroy", "finish"}
    /\ \A p \in Products : ct[p] \in {"none", "live", "destroyed"}

\* The CardTrader create is issued at most once per event and per listing.
AtMostOncePush == /\ \A e \in Events : pushes[e] <= 1
                  /\ Cardinality({p \in Products : ct[p] # "none"}) <= 1

Quiescent ==
    /\ \A e \in 1..nev : ob[e].state = "processed"
    /\ \A w \in Workers : wk[w].pc = "idle"
    /\ ~ENABLED ReconcileLink /\ ~ENABLED ReconcileImport

\* Once every event is applied and the reconcile has run, CardTrader sells a
\* product only while an active Pokoin listing mirrors it.
NoGhostProduct == Quiescent => \A p \in Products :
                     ct[p] = "live" => (lst.st = "active" /\ lst.src = p) \/ mirror[p]

\* After the consumer bumped for version v, no cache entry under the current
\* generation shows the listing older than v.
NoStaleCacheAfterSync == cache.g = gen => cache.v >= syncedVer

\* An event is never left unclaimable while unprocessed (no dead letter).
NoDeadLetter == \A e \in 1..nev :
    ob[e].state = "pending" => ob[e].attempts < MaxAttempts \/ ob[e].leased
                               \/ \E w \in Workers : wk[w].e = e /\ wk[w].pc # "idle"

\* Liveness: every committed change is eventually applied.
AllApplied == \A e \in Events : (ob[e].state = "pending") ~> (ob[e].state = "processed")
(* Witnesses (must be VIOLATED by the fixed model: the behaviour is reachable). *)
NeverPushed == \A p \in Products : ct[p] = "none"
NeverDestroyed == \A p \in Products : ct[p] # "destroyed"
NeverAllProcessed == ~(nev = MaxEvents - 1 /\ \A e \in 1..nev : ob[e].state = "processed")
NeverFreshCache == ~(fills > 0 /\ cache.g = gen /\ cache.v = lst.ver /\ lst.ver > 1)

=============================================================================
