-------------------------- MODULE GestureExclusivity --------------------------
(*
  Desk / shop pointer exclusivity — pokoin market (tcg-paths).

  One pointer against the desk + shop surface: the empty-background marquee
  (select band), HTML5 drags (listing rows, desk art, related tiles, title /
  set / artist links), cart adds (drag onto CartDrop, BuyBtn click), and the
  inert targets (Chrome, clicks).

  Why earlier proofs missed the regressions Giuseppe hit:
  - No SpeciesTitle / ExpansionLink / ArtistLink targets — so a stale
    marquee origin preventDefault-ing their dragstart was invisible.
  - ArtFrame was forbidden from `selected`, so "band from empty selects
    the desk scan" could not fail the model.
  - No pile cardinality — multi listing / related drag without a pile
    satisfied InvListingGhostIsCardArt with a single cardArt ghost.

  Incidents pinned (2026-09-27 "things getting stolen" session):
  - Shop-row click-add silently put items in the cart (the theft).
    Cart may only grow via drag-onto-CartDrop or BuyBtn — 6bb3c1c
    -> CartOnlyViaDropOrBuy.
  - Marquee started from listing rows and stole their drags -> fd3c4d7
    -> InvShopRowNeverArms.
  - Title / set / artist dragstart swallowed by the armed band -> d01443c
    -> InvTitleNeverArms, InvTitleDragIsBundle (W4 witness).
  - Desk art not band-selectable from empty background
    -> InvEmptyBandCanSelectArt (W1 witness).
  - Multi-select piles dragged a single card instead of the pile
    -> a108a62, d01443c
    -> InvMultiDragPiles, InvRelatedOrDeskMultiPiles (W2, W3 witnesses).

  clickChrome intentionally leaves banding/armed untouched: the rubber band
  stays "warm" across browser chrome (e3f78be).

  Bounds:
  - CartBound = 2: two increments expose drop/buy interleavings and the cap;
    larger values only lengthen traces.
  - PileBound = 3: exactly three targets are selectable (ShopRow, RelatedTile,
    ArtFrame), so the model's clamp never binds; it pins the UI cap.

  Out of scope: pointer geometry and timing (armed abstracts the marquee
  threshold), multi-touch / a second pointer, keyboard modifiers, network cart
  behaviour (cartAdds is client-side intent), window blur/focus.

  Configs (scripts/check-gesture-tlc.sh runs all):
  - GestureExclusivity.cfg  safety: TypeOK + Inv* + CartOnlyViaDropOrBuy
  - G2-liveness.cfg         gestures terminate under a fair release
                            (TermDrag / TermBand)
  - W1..W5-*.cfg            witnesses: must FAIL (rc 12), else the model is
                            over-tightened and the run fails.

  Run:  scripts/check-gesture-tlc.sh
*)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  ArtFrame, ShopRow, BandEmpty, CartDrop, BuyBtn, Chrome, RelatedTile,
  SpeciesTitle, ExpansionLink, ArtistLink

Targets == {
  ArtFrame, ShopRow, BandEmpty, CartDrop, BuyBtn, Chrome, RelatedTile,
  SpeciesTitle, ExpansionLink, ArtistLink
}

TitleDrag(t) == t \in {SpeciesTitle, ExpansionLink, ArtistLink}
BandBlocked(t) == t \in {
  ArtFrame, CartDrop, BuyBtn, Chrome, RelatedTile,
  SpeciesTitle, ExpansionLink, ArtistLink
}
CanBand(t)     == t = BandEmpty
CanDrag(t)     == t \in {
  ArtFrame, ShopRow, RelatedTile, SpeciesTitle, ExpansionLink, ArtistLink
}
IsListingDrag(t) == t = ShopRow
IsCardArtDrag(t) == t \in {ArtFrame, RelatedTile}

VARIABLES
  banding,
  dragging,
  armed,             \* marquee crossed the threshold (only then may steal drag)
  cartAdds,
  lastAction,
  lastTarget,
  selected,          \* ShopRow, RelatedTile, ArtFrame
  dragGhost,         \* "cardArt" | "flag" | "none"
  dragKind,          \* "listing" | "card" | "bundle" | "none"
  pileSize           \* 0..3 visible stack layers

vars == << banding, dragging, armed, cartAdds, lastAction, lastTarget,
           selected, dragGhost, dragKind, pileSize >>

CartBound == 2
PileBound == 3

Actions == {
  "idle", "bandArm", "bandPaint", "dragStart", "dropCart",
  "clickBuy", "clickShopRow", "clickArtFrame", "clickChrome", "release"
}

TypeOK ==
  /\ banding \in BOOLEAN
  /\ dragging \in BOOLEAN
  /\ armed \in BOOLEAN
  /\ cartAdds \in 0..CartBound
  /\ lastAction \in Actions
  /\ lastTarget \in Targets
  /\ selected \subseteq {ShopRow, RelatedTile, ArtFrame}
  /\ dragGhost \in {"cardArt", "flag", "none"}
  /\ dragKind \in {"listing", "card", "bundle", "none"}
  /\ pileSize \in 0..PileBound

Init ==
  /\ banding = FALSE
  /\ dragging = FALSE
  /\ armed = FALSE
  /\ cartAdds = 0
  /\ lastAction = "idle"
  /\ lastTarget = Chrome
  /\ selected = {}
  /\ dragGhost = "none"
  /\ dragKind = "none"
  /\ pileSize = 0

BandArm(t) ==
  /\ IF CanBand(t) /\ ~BandBlocked(t) /\ ~dragging
     THEN /\ banding' = TRUE
          /\ armed' = FALSE
          /\ lastAction' = "bandArm"
          /\ lastTarget' = t
          /\ UNCHANGED << dragging, cartAdds, selected, dragGhost, dragKind, pileSize >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>

\* Empty-background band may select shop rows, related tiles, AND the desk scan.
BandPaint(hit) ==
  /\ banding = TRUE
  /\ armed' = TRUE
  /\ lastAction' = "bandPaint"
  /\ lastTarget' = hit
  /\ IF hit \in {ShopRow, RelatedTile, ArtFrame}
     THEN selected' = selected \cup {hit}
     ELSE UNCHANGED selected
  /\ UNCHANGED << banding, dragging, cartAdds, dragGhost, dragKind, pileSize >>

DragStart(t) ==
  /\ IF CanDrag(t) /\ ~(banding /\ armed)
     THEN /\ dragging' = TRUE
          /\ banding' = FALSE
          /\ armed' = FALSE
          /\ lastAction' = "dragStart"
          /\ lastTarget' = t
          /\ dragKind' = IF IsListingDrag(t) THEN "listing"
                         ELSE IF TitleDrag(t) THEN "bundle"
                         ELSE "card"
          /\ dragGhost' = "cardArt"
          /\ pileSize' = IF t = ShopRow /\ ShopRow \in selected /\ Cardinality(selected) > 1
                         THEN IF Cardinality(selected) > PileBound THEN PileBound ELSE Cardinality(selected)
                         ELSE IF t \in {ArtFrame, RelatedTile} /\ Cardinality(selected \cap {ArtFrame, RelatedTile}) > 1
                         THEN IF Cardinality(selected \cap {ArtFrame, RelatedTile}) > PileBound
                              THEN PileBound
                              ELSE Cardinality(selected \cap {ArtFrame, RelatedTile})
                         ELSE 1
          /\ UNCHANGED << cartAdds, selected >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>

DropCart(t) ==
  /\ IF t = CartDrop /\ dragging /\ cartAdds < CartBound
     THEN /\ cartAdds' = cartAdds + 1
          /\ dragging' = FALSE
          /\ dragGhost' = "none"
          /\ dragKind' = "none"
          /\ pileSize' = 0
          /\ lastAction' = "dropCart"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, armed, selected >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>

ClickBuy(t) ==
  /\ IF t = BuyBtn /\ cartAdds < CartBound
     THEN /\ cartAdds' = cartAdds + 1
          /\ lastAction' = "clickBuy"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, selected, dragGhost, dragKind, pileSize >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>

ClickShop(t) ==
  /\ IF t = ShopRow
     THEN /\ lastAction' = "clickShopRow"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>

ClickArt(t) ==
  /\ IF t = ArtFrame
     THEN /\ lastAction' = "clickArtFrame"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>

ClickChrome(t) ==
  /\ IF t = Chrome
     THEN /\ lastAction' = "clickChrome"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, armed, cartAdds, selected, dragGhost, dragKind, pileSize >>

Release(t) ==
  /\ banding' = FALSE
  /\ dragging' = FALSE
  /\ armed' = FALSE
  /\ dragGhost' = "none"
  /\ dragKind' = "none"
  /\ pileSize' = 0
  /\ lastAction' = "release"
  /\ lastTarget' = t
  /\ UNCHANGED << cartAdds, selected >>

Next ==
  \E t \in Targets:
    \/ BandArm(t)
    \/ BandPaint(t)
    \/ DragStart(t)
    \/ DropCart(t)
    \/ ClickBuy(t)
    \/ ClickShop(t)
    \/ ClickArt(t)
    \/ ClickChrome(t)
    \/ Release(t)

Spec == Init /\ [][Next]_vars

\* A fair user eventually lets go of the pointer. Release is the only action
\* that unconditionally ends a gesture; it is enabled with a state change in
\* every reachable state, so WF forces it to recur.
FairAssump == WF_vars(\E t \in Targets: Release(t))

LivenessSpec == Spec /\ FairAssump

InvMutualExclusion == ~(banding /\ dragging)

\* Pointerdown on the desk scan never arms the band (HTML5 drag owns it).
InvArtNeverArms ==
  (lastAction = "bandArm") => (lastTarget # ArtFrame)

\* Title / set / artist never arm the shop marquee.
InvTitleNeverArms ==
  (lastAction = "bandArm") => ~TitleDrag(lastTarget)

\* Shop rows never arm the marquee — only empty background does.
InvShopRowNeverArms ==
  (lastAction = "bandArm") => (lastTarget # ShopRow)

\* Empty-background paint may select the desk scan.
InvEmptyBandCanSelectArt ==
  (lastAction = "bandPaint" /\ lastTarget = ArtFrame) => (ArtFrame \in selected)

InvEmptyBandCanSelectShop ==
  (lastAction = "bandPaint" /\ lastTarget = ShopRow) => (ShopRow \in selected)

InvListingGhostIsCardArt ==
  (dragging /\ dragKind = "listing") => (dragGhost = "cardArt")

InvListingRicherThanCard ==
  (lastAction = "dragStart" /\ lastTarget = ShopRow) => (dragKind = "listing")

InvTitleDragIsBundle ==
  (lastAction = "dragStart" /\ TitleDrag(lastTarget)) => (dragKind = "bundle")

\* Multi-selected listings or desk+related drag as a pile (size ≥ 2).
InvMultiDragPiles ==
  (lastAction = "dragStart"
    /\ lastTarget = ShopRow
    /\ ShopRow \in selected
    /\ Cardinality(selected) > 1)
  => (pileSize >= 2)

InvRelatedOrDeskMultiPiles ==
  (lastAction = "dragStart"
    /\ lastTarget \in {ArtFrame, RelatedTile}
    /\ Cardinality(selected \cap {ArtFrame, RelatedTile}) > 1)
  => (pileSize >= 2)

\* The theft invariant: cart grows ONLY by drag-onto-CartDrop or BuyBtn.
\* An action property (quantifies over steps), so it replaces the old
\* vacuous InvClickKeepsCart == (... ) => TRUE.
CartOnlyViaDropOrBuy ==
  [][ (lastAction' \notin {"dropCart", "clickBuy"}) => cartAdds' = cartAdds ]_vars

\* Gestures terminate: no action sequence under a fair user can latch a
\* marquee or a drag forever (catches a Release that forgets a reset).
TermDrag == [](dragging => <> ~dragging)
TermBand == [](banding => <> ~banding)

\* ---- Reachability witnesses (checked ONLY by W*.cfg; must FAIL there) ----
\* Each No* invariant asserts the fixed behaviour is UNREACHABLE; TLC's
\* counterexample (rc 12) is the witness that the model still exercises it.
\* A passing witness means guards were over-tightened: model too weak.

\* W1: empty-background band really can select the desk scan.
NoArtBandSel == ~(lastAction = "bandPaint" /\ lastTarget = ArtFrame)

\* W2: dragging a multi-selected listing row really produces a pile.
NoListingPileDrag == ~(dragKind = "listing" /\ pileSize >= 2)

\* W3: dragging with desk + related tiles selected really produces a pile.
NoCardPileDrag == ~(dragKind = "card" /\ pileSize >= 2)

\* W4: title / set / artist really drag as bundles.
NoBundleDrag == ~(dragging /\ dragKind = "bundle")

\* W5: drag-onto-cart really fires (DropCart guard not over-tightened).
NoCartDrop == ~(lastAction = "dropCart")

THEOREM Spec => [](
  TypeOK
  /\ InvMutualExclusion
  /\ InvArtNeverArms
  /\ InvTitleNeverArms
  /\ InvShopRowNeverArms
  /\ InvEmptyBandCanSelectArt
  /\ InvEmptyBandCanSelectShop
  /\ InvListingGhostIsCardArt
  /\ InvListingRicherThanCard
  /\ InvTitleDragIsBundle
  /\ InvMultiDragPiles
  /\ InvRelatedOrDeskMultiPiles
)

THEOREM Spec => CartOnlyViaDropOrBuy

THEOREM LivenessSpec => (TermDrag /\ TermBand)

=============================================================================
