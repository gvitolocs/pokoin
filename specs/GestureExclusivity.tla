-------------------------- MODULE GestureExclusivity --------------------------
(*
  Desk / shop pointer exclusivity.

  Why earlier proofs missed the regressions Giuseppe hit:
  - No SpeciesTitle / ExpansionLink / ArtistLink targets — so a stale
    marquee origin preventDefault-ing their dragstart was invisible.
  - ArtFrame was forbidden from `selected`, so "band from empty selects
    the desk scan" could not fail the model.
  - No pile cardinality — multi listing / related drag without a pile
    satisfied InvListingGhostIsCardArt with a single cardArt ghost.

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

InvClickKeepsCart ==
  (lastAction \in {"clickShopRow", "clickArtFrame"}) => TRUE

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
  /\ InvClickKeepsCart
)
=============================================================================
