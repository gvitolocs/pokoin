---------------------------- MODULE Model ----------------------------
(***************************************************************************)
(* Who owns one Pokoin listing's price when Card Rails is connected        *)
(* (owner, 2026-11-08: "one pricer": Pokoin prices, Card Rails mirrors).   *)
(*                                                                         *)
(* One listing, listed once through the Card Rails connector `list` (the   *)
(* item's choice, the call's, the account default, or none). Then, in any  *)
(* order:                                                                  *)
(*  - pricing-group runs (Apply and the daily `pricing-groups-daily`) read *)
(*    the group's rows, then write each new price;                         *)
(*  - the market moves a group's target;                                   *)
(*  - the seller edits the listing in MyPokoin (a form opened earlier,     *)
(*    saved later: `PATCH /api/marketplace-listings`) or adds/removes it   *)
(*    on the Pricer board;                                                 *)
(*  - Card Rails sends `update` (a price, no price, `pricingGroupId` set   *)
(*    or null), pulls `listings` into its own row (a cached copy that can  *)
(*    be stale) and runs its own CardTrader import;                        *)
(*  - Pokoin's own CardTrader sync links the listing to a CardTrader       *)
(*    product (writing the product's net price once) or creates one, and   *)
(*    pushes Pokoin price edits to CardTrader as the gross ask.            *)
(*                                                                         *)
(* Card Rails is modelled as agreed: it sends a price only when the seller *)
(* changed it in that edit, sends `pricingGroupId: null` with it ("Price   *)
(* myself"), and never writes prices into a Pokoin-linked row from its     *)
(* CardTrader import. Each of those is a constant, so bugs/*.cfg can turn  *)
(* one off and show the bug it prevents. README.md maps every action to    *)
(* the Rust code.                                                          *)
(***************************************************************************)
EXTENDS Naturals, TLC, Rules

CONSTANTS
    Groups,        \* the seller's pricing groups
    MaxP,          \* prices 1..MaxP (abstract units); 0 = unpriced (paused)
    MaxMoves,      \* market moves of a group's target
    MaxCrEdits,    \* Card Rails `update` calls
    MaxMpEdits,    \* MyPokoin listing edits
    MaxRuns,       \* group runs (Apply or daily)
    MaxImports,    \* Card Rails CardTrader imports
    MaxBoard,      \* Pricer-board moves (add to / remove from a group)
    Default,       \* the account default: "group" | "gone" (its group was deleted) | "none"
    \* --- Pokoin ---
    PokoinLeaves,      \* a manual price takes the listing out of its group (FALSE: before #530)
    AtomicManual,      \* the group move and the price write are one transaction under the row lock
    GuardedRun,        \* a run writes only if the listing is still in the group, under the row lock
    DefaultMode,       \* "off" (before #530) | "safe" (#530) | "naive" (refuses a gone default)
    FormSendsOnlyChanged, \* MyPokoin's form sends a price only when the seller changed it, with null
    \* --- Card Rails (as agreed) ---
    CrSendsOnlyChanged,   \* FALSE: R5, every edit resends the cached price
    CrImportSkipsLinked,  \* FALSE: R6, its CardTrader import writes the ask into the linked row
    NullOnPrice           \* "Price myself" and a typed price carry pricingGroupId: null

Prices == 1..MaxP
Triggers == {"apply", "daily"}
Gross(p) == p + 1                      \* CardTrader ask for a Pokoin price (one fee unit)
DefaultGroup == CHOOSE g \in Groups : TRUE

VARIABLES
    listed, refused,
    price,       \* the Pokoin listing's price (0: unpriced, paused)
    group,       \* its pricing group, or NoGroup
    target,      \* [Groups -> Prices]: what each group's strategy prices it at now
    run,         \* [Triggers -> [pc, g, tgt]]: a group run between its read and its write
    upd,         \* Card Rails `update` in flight: [pc, kind, p, named]
    mp,          \* MyPokoin edit: [pc, form, kind, p, named]
    crLinked, crPrice, crGroup, crSrc, crDirty,   \* Card Rails' row
    ask, ctLinked, ctEdit,                        \* CardTrader product, queued Pokoin → CT edit
    \* ghosts
    pinned,      \* the price in force is one the seller typed (until it joins a group)
    wiped,       \* a group run overwrote a pinned price
    intent,      \* the seller's last processed request said "I price this myself"
    sneaky,      \* an update/edit that changed no price and named no group moved price or group
    bounces,     \* Card Rails row price flips between its CardTrader import and the pull
    defaulted, skipped,
    moves, crEdits, mpEdits, runs, imports, board

ghosts == <<pinned, wiped, intent, sneaky, bounces, defaulted, skipped>>
counters == <<moves, crEdits, mpEdits, runs, imports, board>>
cr == <<crLinked, crPrice, crGroup, crSrc, crDirty>>
ct == <<ask, ctLinked, ctEdit>>
vars == <<listed, refused, price, group, target, run, upd, mp, cr, ct, ghosts, counters>>

Idle == [pc |-> "idle", kind |-> "", p |-> 0, named |-> "absent"]
RunIdle == [pc |-> "idle", g |-> NoGroup, tgt |-> 0]

Init ==
    /\ listed = FALSE /\ refused = FALSE /\ price = 0 /\ group = NoGroup
    /\ target \in [Groups -> Prices]
    /\ run = [t \in Triggers |-> RunIdle]
    /\ upd = Idle
    /\ mp = [pc |-> "closed", form |-> 0, kind |-> "", p |-> 0, named |-> "absent"]
    /\ crLinked = FALSE /\ crPrice = 0 /\ crGroup = NoGroup /\ crSrc = "pull" /\ crDirty = FALSE
    /\ ask \in {0, Gross(1)} /\ ctLinked = FALSE /\ ctEdit = 0
    /\ pinned = FALSE /\ wiped = FALSE /\ intent = FALSE /\ sneaky = FALSE
    /\ bounces = 0 /\ defaulted = FALSE /\ skipped = FALSE
    /\ moves = 0 /\ crEdits = 0 /\ mpEdits = 0 /\ runs = 0 /\ imports = 0 /\ board = 0

(************************** the shared rule ******************************)
\* `Move` and `IsManual` are Rules.tla (checked against the Rust code by
\* conformance/move-table.txt).
Manual(p) == IsManual(p, price)

\* The move a request makes. Before #530, `update` and the edit never
\* touched membership. The edit (`PATCH`) only ever leaves a group.
MoveOf(req, isPatch) ==
    IF ~PokoinLeaves THEN "keep"
    ELSE LET m == Move(group, req.named, Manual(req.p))
         IN IF isPatch /\ m = "join" THEN "keep" ELSE m

SellerKinds == {"price", "myself", "other", "import"}

\* Pokoin's price edit reaches CardTrader only for a linked listing.
QueueCt(np) == ctEdit' = IF ctLinked /\ np # price THEN np ELSE ctEdit

GroupAfter(req, isPatch) ==
    LET m == MoveOf(req, isPatch) IN
    CASE m = "leave" -> NoGroup
      [] m = "join"  -> req.named
      [] OTHER       -> group

\* Leaving hands the price in force to the seller; joining hands it to the group.
PinAtGroupStep(req, isPatch) ==
    LET m == MoveOf(req, isPatch) IN
    CASE m = "join"  -> FALSE
      [] m = "leave" -> price > 0
      [] OTHER       -> pinned

\* The group step of a request (leave / join / keep) and its ghosts.
GroupStep(req, isPatch) ==
    LET m == MoveOf(req, isPatch) IN
    /\ group' = GroupAfter(req, isPatch)
    /\ intent' = CASE req.kind \in {"price", "myself"} -> TRUE
                   [] req.kind = "rejoin"            -> FALSE
                   [] OTHER                          -> intent
    \* an edit of another field must neither move the group nor change the price
    /\ sneaky' = (sneaky \/ (req.kind = "other" /\ (m # "keep" \/ Manual(req.p))))

\* The price step: the price the request carries, if any.
PriceStep(req) ==
    LET np == IF req.p > 0 THEN req.p ELSE price IN
    /\ price' = np
    /\ QueueCt(np)

\* A price the seller typed is the seller's when it lands outside a group;
\* inside one (it named that group, or was put back meanwhile) it is the
\* group's. Before #530 it stayed in its group as the seller's price.
PinAfter(req, grp, pin) ==
    IF req.p > 0 /\ req.p # price /\ req.kind \in SellerKinds /\ (grp = NoGroup \/ ~PokoinLeaves)
    THEN TRUE
    ELSE pin

\* Card Rails reads the listing back (the `update` answer, or a pull).
CrRead(np, ng) ==
    /\ crPrice' = np /\ crGroup' = ng /\ crSrc' = "pull"
    /\ bounces' = IF crSrc = "import" /\ crPrice # np THEN bounces + 1 ELSE bounces

(******************************* list ************************************)
\* seller_api.rs `list`: item choice > call choice > (unpriced only) the
\* account default; a priced item with no choice keeps its price, no group.
ListItem ==
    /\ ~listed /\ ~refused
    /\ \E choice \in {"item", "call", "strategy", "none"}, p \in 0..MaxP :
        LET viaDefault == choice = "none" /\ p = 0 /\ Default = "group" /\ DefaultMode # "off"
            refuse == choice = "none" /\ p = 0 /\ Default = "gone" /\ DefaultMode = "naive"
        IN IF refuse
           THEN /\ refused' = TRUE
                /\ UNCHANGED <<listed, price, group, cr, pinned, defaulted>>
           ELSE \E g \in Groups :
                LET ng == CASE choice \in {"item", "call"} -> g
                            [] viaDefault                  -> DefaultGroup
                            [] OTHER                       -> NoGroup
                    np == CASE p > 0               -> p
                            [] ng # NoGroup        -> target[ng]
                            [] choice = "strategy" -> target[g]
                            [] OTHER               -> 0
                IN /\ listed' = TRUE /\ refused' = FALSE
                   /\ price' = np /\ group' = ng
                   /\ pinned' = (ng = NoGroup /\ np > 0)
                   /\ defaulted' = viaDefault
                   /\ crLinked' = TRUE /\ crPrice' = np /\ crGroup' = ng /\ crSrc' = "pull"
                   /\ UNCHANGED crDirty
    /\ UNCHANGED <<target, run, upd, mp, ct, wiped, intent, sneaky, bounces, skipped, counters>>

(*************************** pricing groups ******************************)
MarketMove ==
    /\ moves < MaxMoves
    /\ \E g \in Groups, t \in Prices : t # target[g] /\ target' = [target EXCEPT ![g] = t]
    /\ moves' = moves + 1
    /\ UNCHANGED <<listed, refused, price, group, run, upd, mp, cr, ct, ghosts,
                   crEdits, mpEdits, runs, imports, board>>

\* pricer.rs `apply_group` → `group_rows`: the listing is read with the group.
RunRead(t) ==
    /\ listed /\ runs < MaxRuns /\ run[t].pc = "idle" /\ group # NoGroup
    /\ run' = [run EXCEPT ![t] = [pc |-> "read", g |-> group, tgt |-> target[group]]]
    /\ runs' = runs + 1
    /\ UNCHANGED <<listed, refused, price, group, target, upd, mp, cr, ct, ghosts,
                   moves, crEdits, mpEdits, imports, board>>

\* `run_plan` writes each change through `update_listing`. Guarded: under
\* the row lock, only if the listing is still in that group.
RunWrite(t) ==
    LET r == run[t]
        still == group = r.g
        writes == (still \/ ~GuardedRun) /\ price # r.tgt
    IN
    /\ r.pc = "read"
    /\ run' = [run EXCEPT ![t] = RunIdle]
    /\ IF writes
       THEN /\ price' = r.tgt /\ QueueCt(r.tgt)
            /\ wiped' = (wiped \/ pinned)
       ELSE UNCHANGED <<price, ctEdit, wiped>>
    /\ skipped' = (skipped \/ (GuardedRun /\ ~still))
    /\ UNCHANGED <<listed, refused, group, target, upd, mp, cr, ask, ctLinked,
                   pinned, intent, sneaky, bounces, defaulted, counters>>

\* The Pricer board: "Add to group" / "Remove from group" (one statement
\* each, under the listings' row locks).
BoardAdd ==
    /\ listed /\ board < MaxBoard
    /\ \E g \in Groups \ {group} : group' = g
    /\ pinned' = FALSE /\ intent' = FALSE /\ board' = board + 1
    /\ UNCHANGED <<listed, refused, price, target, run, upd, mp, cr, ct,
                   wiped, sneaky, bounces, defaulted, skipped, moves, crEdits, mpEdits, runs, imports>>

BoardRemove ==
    /\ listed /\ board < MaxBoard /\ group # NoGroup
    /\ group' = NoGroup /\ pinned' = (price > 0) /\ intent' = TRUE /\ board' = board + 1
    /\ UNCHANGED <<listed, refused, price, target, run, upd, mp, cr, ct,
                   wiped, sneaky, bounces, defaulted, skipped, moves, crEdits, mpEdits, runs, imports>>

(**************************** MyPokoin edit ******************************)
\* The listing edit form reads the listing when it opens…
MpOpen ==
    /\ listed /\ mp.pc = "closed" /\ mpEdits < MaxMpEdits
    /\ mp' = [mp EXCEPT !.pc = "open", !.form = price]
    /\ mpEdits' = mpEdits + 1
    /\ UNCHANGED <<listed, refused, price, group, target, run, upd, cr, ct, ghosts,
                   moves, crEdits, runs, imports, board>>

\* …and saves later: another field only, or a price the seller changed.
MpSave ==
    /\ mp.pc = "open"
    /\ \/ mp' = [mp EXCEPT !.pc = "sent", !.kind = "other", !.named = "absent",
                           !.p = IF FormSendsOnlyChanged THEN 0 ELSE mp.form]
       \/ \E p \in Prices \ {mp.form} :
            mp' = [mp EXCEPT !.pc = "sent", !.kind = "price", !.p = p,
                             !.named = IF FormSendsOnlyChanged THEN "null" ELSE "absent"]
    /\ UNCHANGED <<listed, refused, price, group, target, run, upd, cr, ct, ghosts, counters>>

\* `PATCH /api/marketplace-listings`: the group step, then the price step.
MpGroup ==
    /\ mp.pc = "sent"
    /\ GroupStep(mp, TRUE)
    /\ IF AtomicManual
       THEN /\ PriceStep(mp)
            /\ pinned' = PinAfter(mp, GroupAfter(mp, TRUE), PinAtGroupStep(mp, TRUE))
            /\ mp' = [mp EXCEPT !.pc = "closed"]
       ELSE /\ mp' = [mp EXCEPT !.pc = "write"]
            /\ pinned' = PinAtGroupStep(mp, TRUE)
            /\ UNCHANGED <<price, ctEdit>>
    /\ UNCHANGED <<listed, refused, target, run, upd, cr, ask, ctLinked,
                   wiped, bounces, defaulted, skipped, counters>>

MpWrite ==
    /\ mp.pc = "write"
    /\ PriceStep(mp)
    /\ pinned' = PinAfter(mp, group, pinned)
    /\ mp' = [mp EXCEPT !.pc = "closed"]
    /\ UNCHANGED <<listed, refused, group, target, run, upd, cr, ask, ctLinked,
                   wiped, intent, sneaky, bounces, defaulted, skipped, counters>>

(*************************** Card Rails ***********************************)
CrCanEdit == listed /\ crLinked /\ upd.pc = "idle" /\ crEdits < MaxCrEdits

CrSend(kind, p, named) ==
    /\ upd' = [pc |-> "sent", kind |-> kind, p |-> p, named |-> named]
    /\ crEdits' = crEdits + 1

\* An edit of another field (location, condition): no price (R5: the cached one).
CrEditOther ==
    /\ CrCanEdit
    /\ CrSend("other", IF CrSendsOnlyChanged THEN 0 ELSE crPrice, "absent")
    /\ UNCHANGED <<listed, refused, price, group, target, run, mp, cr, ct, ghosts,
                   moves, mpEdits, runs, imports, board>>

\* The seller changed the price in this edit.
CrEditPrice ==
    /\ CrCanEdit
    /\ \E p \in Prices \ {crPrice} :
        /\ CrSend("price", p, IF NullOnPrice THEN "null" ELSE "absent")
        /\ crPrice' = p /\ crSrc' = "seller"
    /\ UNCHANGED <<listed, refused, price, group, target, run, mp, crLinked, crGroup, crDirty,
                   ct, ghosts, moves, mpEdits, runs, imports, board>>

\* "Price myself" on a row priced by Pokoin, keeping the price shown.
CrPriceMyself ==
    /\ CrCanEdit /\ crGroup # NoGroup
    /\ IF NullOnPrice THEN CrSend("myself", 0, "null") ELSE CrSend("myself", crPrice, "absent")
    /\ UNCHANGED <<listed, refused, price, group, target, run, mp, cr, ct, ghosts,
                   moves, mpEdits, runs, imports, board>>

\* "Priced by Pokoin" again: pricingGroupId names a group.
CrRejoin ==
    /\ CrCanEdit
    /\ \E g \in Groups : CrSend("rejoin", 0, g)
    /\ UNCHANGED <<listed, refused, price, group, target, run, mp, cr, ct, ghosts,
                   moves, mpEdits, runs, imports, board>>

\* R6 only: a price the import wrote is pushed to Pokoin as a change.
CrSyncDirty ==
    /\ listed /\ crLinked /\ upd.pc = "idle" /\ crDirty
    /\ upd' = [pc |-> "sent", kind |-> "import", p |-> crPrice, named |-> "absent"]
    /\ crDirty' = FALSE
    /\ UNCHANGED <<listed, refused, price, group, target, run, mp, crLinked, crPrice, crGroup, crSrc,
                   ct, ghosts, counters>>

\* seller_api.rs `update`: the group step, then the price write; the
\* answer's `listing` refreshes Card Rails' row.
UpdGroup ==
    /\ upd.pc = "sent"
    /\ GroupStep(upd, FALSE)
    /\ IF AtomicManual
       THEN /\ PriceStep(upd)
            /\ pinned' = PinAfter(upd, GroupAfter(upd, FALSE), PinAtGroupStep(upd, FALSE))
            /\ upd' = Idle
            /\ CrRead(IF upd.p > 0 THEN upd.p ELSE price, GroupAfter(upd, FALSE))
       ELSE /\ upd' = [upd EXCEPT !.pc = "write"]
            /\ pinned' = PinAtGroupStep(upd, FALSE)
            /\ UNCHANGED <<price, ctEdit, crPrice, crGroup, crSrc, bounces>>
    /\ UNCHANGED <<listed, refused, target, run, mp, crLinked, crDirty, ask, ctLinked,
                   wiped, defaulted, skipped, counters>>

UpdWrite ==
    /\ upd.pc = "write"
    /\ PriceStep(upd)
    /\ pinned' = PinAfter(upd, group, pinned)
    /\ upd' = Idle
    /\ CrRead(IF upd.p > 0 THEN upd.p ELSE price, group)
    /\ UNCHANGED <<listed, refused, group, target, run, mp, crLinked, crDirty, ask, ctLinked,
                   wiped, intent, sneaky, defaulted, skipped, counters>>

\* The `listings` pull into Card Rails' own row.
CrPull ==
    /\ crLinked /\ (crPrice # price \/ crGroup # group)
    /\ CrRead(price, group)
    /\ UNCHANGED <<listed, refused, price, group, target, run, upd, mp, crLinked, crDirty,
                   ct, pinned, wiped, intent, sneaky, defaulted, skipped, counters>>

\* Card Rails' own CardTrader import. As agreed it never writes a price
\* into a Pokoin-linked row; R6 wrote the ask (and pushed it as a change).
CrCtImport ==
    /\ ~CrImportSkipsLinked /\ crLinked /\ ask > 0 /\ crPrice # ask /\ imports < MaxImports
    /\ crPrice' = ask /\ crSrc' = "import" /\ crDirty' = TRUE
    /\ bounces' = IF crSrc = "pull" /\ crPrice > 0 THEN bounces + 1 ELSE bounces
    /\ imports' = imports + 1
    /\ UNCHANGED <<listed, refused, price, group, target, run, upd, mp, crLinked, crGroup,
                   ct, pinned, wiped, intent, sneaky, defaulted, skipped,
                   moves, crEdits, mpEdits, runs, board>>

(************************ Pokoin's CardTrader sync ************************)
\* Reconcile `LinkExisting` (`link_existing_listing`): an unlinked listing
\* matched to an existing product takes the product's net price, once.
CtLink ==
    /\ listed /\ ~ctLinked /\ ask > 0
    /\ ctLinked' = TRUE /\ price' = ask - 1
    /\ pinned' = IF group = NoGroup THEN TRUE ELSE pinned
    /\ UNCHANGED <<listed, refused, group, target, run, upd, mp, cr, ask, ctEdit,
                   wiped, intent, sneaky, bounces, defaulted, skipped, counters>>

\* `push_unlisted`: an unlinked priced listing becomes a product at the gross ask.
CtPush ==
    /\ listed /\ ~ctLinked /\ ask = 0 /\ price > 0
    /\ ctLinked' = TRUE /\ ask' = Gross(price)
    /\ UNCHANGED <<listed, refused, price, group, target, run, upd, mp, cr, ctEdit, ghosts, counters>>

\* `listing_sync::edit_cardtrader`: the queued edit lands as the gross ask.
CtEditDeliver ==
    /\ ctEdit > 0
    /\ ask' = Gross(ctEdit) /\ ctEdit' = 0
    /\ UNCHANGED <<listed, refused, price, group, target, run, upd, mp, cr, ctLinked, ghosts, counters>>

Next ==
    \/ ListItem \/ MarketMove
    \/ \E t \in Triggers : RunRead(t) \/ RunWrite(t)
    \/ BoardAdd \/ BoardRemove
    \/ MpOpen \/ MpSave \/ MpGroup \/ MpWrite
    \/ CrEditOther \/ CrEditPrice \/ CrPriceMyself \/ CrRejoin \/ CrSyncDirty
    \/ UpdGroup \/ UpdWrite \/ CrPull \/ CrCtImport
    \/ CtLink \/ CtPush \/ CtEditDeliver

Fairness ==
    /\ WF_vars(CrPull) /\ WF_vars(UpdGroup) /\ WF_vars(UpdWrite)
    /\ WF_vars(MpGroup) /\ WF_vars(MpWrite) /\ WF_vars(CtEditDeliver)
    /\ \A t \in Triggers : WF_vars(RunWrite(t))

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

(***************************** properties *********************************)
TypeOK ==
    /\ group \in Groups \cup {NoGroup}
    /\ price \in 0..(MaxP + MaxImports + 1)
    /\ upd.pc \in {"idle", "sent", "write"} /\ mp.pc \in {"closed", "open", "sent", "write"}

\* PO1 OneOwner: a listing is priced by exactly one owner, its group or the
\* seller (a price the seller typed is never held inside a group).
OneOwner == ~(pinned /\ group # NoGroup)

\* PO2 ManualPriceKept: a group run never overwrites a price the seller
\* typed, until the listing joins a group again.
ManualPriceKept == ~wiped

\* PO3 NoPriceNoChange: a write that carries no new price and names no
\* group (an edit of another field) changes neither the price nor the group.
NoPriceNoChange == ~sneaky

\* PO4 NoPingPong: Card Rails' CardTrader import and the Pokoin pull never
\* flip the row's price back and forth.
NoPingPong == bounces <= 1

\* PO5 PriceMyselfHonoured: after "Price myself" (or a typed price) is
\* processed, the listing is out of any group until it is put back in one,
\* even when the price stays the same.
PriceMyselfHonoured == (intent /\ upd.pc = "idle" /\ mp.pc \in {"closed", "open"}) => group = NoGroup

\* PO6 ListNeverRefused: `list` never refuses an item over a bad account default.
ListNeverRefused == ~refused

\* PO7 UnpricedStaysPaused: a listing no group prices and the seller did not
\* price stays unpriced (paused at 0).
UnpricedStaysPaused == (listed /\ group = NoGroup /\ ~pinned) => price = 0

\* PO8 CardRailsConverges: once nothing else happens, a pull brings Card
\* Rails' row to Pokoin's price and group.
CardRailsConverges == <>[](crLinked => (crPrice = price /\ crGroup = group))

\* Bounds for the bug configs, where R6 makes the price climb.
Bounds == price <= MaxP + MaxImports + 1 /\ ask <= MaxP + MaxImports + 2

\* Witnesses (must be violated in witness/*.cfg: the behaviour is reachable).
NeverLeftByPrice == ~(intent /\ group = NoGroup /\ pinned /\ upd.pc = "idle")
NeverDefaulted == ~defaulted
NeverRunSkipped == ~skipped
\* Card Rails' row mirrors a price the group set after the listing was listed.
NeverMirroredGroupPrice == ~(crLinked /\ group # NoGroup /\ moves > 0 /\ price = target[group]
                             /\ crPrice = price /\ runs > 0 /\ upd.pc = "idle")
=============================================================================
