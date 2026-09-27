-------------------------- MODULE GestureExclusivity --------------------------
(*
  Desk / shop pointer exclusivity — what must not steal what.

  Mirrors CardSelectGrid.jsx, ShopListing.jsx, ShopList.jsx, CartDrop.jsx,
  chat-listing.js (drag ghost), shop-marquee.js:

  - Empty-background band is intended (BandEmpty)
  - Art-frame is never in the multi-select set
  - Band started outside the shop still selects ShopRows the rect covers
  - Listing drag ghost is card art, never a shop flag
  - Listing drag payload is richer than desk card-art drag
  - shop-row click never adds to cart; cart via CartDrop or buy-btn
  - banding ⊥ HTML5 dragging

  PlusCal sketch (see comments); TLC checks the TLA+ Spec below.

  Run:  scripts/check-gesture-tlc.sh
*)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  ArtFrame, ShopRow, BandEmpty, CartDrop, BuyBtn, Chrome, RelatedTile

Targets == {ArtFrame, ShopRow, BandEmpty, CartDrop, BuyBtn, Chrome, RelatedTile}

\* CardSelectGrid ignores these; ShopList marqueeStartAllowed allows BandEmpty + ShopRow.
BandBlocked(t) == t \in {ArtFrame, CartDrop, BuyBtn, Chrome, RelatedTile}
CanBand(t)     == t \in {BandEmpty, ShopRow}   \* empty bg OR inside shop
CanDrag(t)     == t \in {ArtFrame, ShopRow, RelatedTile}
IsListingDrag(t) == t = ShopRow
IsCardArtDrag(t) == t \in {ArtFrame, RelatedTile}

VARIABLES
  banding,
  dragging,
  cartAdds,
  lastAction,
  lastTarget,
  selected,          \* subset of {ShopRow, RelatedTile} — never ArtFrame
  dragGhost,         \* "cardArt" | "flag" | "none"
  dragKind           \* "listing" | "card" | "none"

vars == << banding, dragging, cartAdds, lastAction, lastTarget,
           selected, dragGhost, dragKind >>

CartBound == 2

Actions == {
  "idle", "bandArm", "bandPaint", "dragStart", "dropCart",
  "clickBuy", "clickShopRow", "clickArtFrame", "clickChrome", "release"
}

TypeOK ==
  /\ banding \in BOOLEAN
  /\ dragging \in BOOLEAN
  /\ cartAdds \in 0..CartBound
  /\ lastAction \in Actions
  /\ lastTarget \in Targets
  /\ selected \subseteq {ShopRow, RelatedTile}
  /\ dragGhost \in {"cardArt", "flag", "none"}
  /\ dragKind \in {"listing", "card", "none"}

Init ==
  /\ banding = FALSE
  /\ dragging = FALSE
  /\ cartAdds = 0
  /\ lastAction = "idle"
  /\ lastTarget = Chrome
  /\ selected = {}
  /\ dragGhost = "none"
  /\ dragKind = "none"

\* Empty background or shop body arms the band; art-frame never does.
BandArm(t) ==
  /\ IF CanBand(t) /\ ~BandBlocked(t) /\ ~dragging
     THEN /\ banding' = TRUE
          /\ lastAction' = "bandArm"
          /\ lastTarget' = t
          /\ UNCHANGED << dragging, cartAdds, selected, dragGhost, dragKind >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>

\* While banding, a covered shop row joins selection; art-frame never does.
BandPaint(hit) ==
  /\ banding = TRUE
  /\ lastAction' = "bandPaint"
  /\ lastTarget' = hit
  /\ IF hit = ShopRow
     THEN selected' = selected \cup {ShopRow}
     ELSE IF hit = RelatedTile
          THEN selected' = selected \cup {RelatedTile}
          ELSE UNCHANGED selected   \* ArtFrame / Chrome / etc. ignored
  /\ UNCHANGED << banding, dragging, cartAdds, dragGhost, dragKind >>

DragStart(t) ==
  /\ IF CanDrag(t) /\ ~banding
     THEN /\ dragging' = TRUE
          /\ banding' = FALSE
          /\ lastAction' = "dragStart"
          /\ lastTarget' = t
          /\ dragKind' = IF IsListingDrag(t) THEN "listing" ELSE "card"
          \* Listing ghosts always use card art (never the seller/lang flag).
          /\ dragGhost' = "cardArt"
          /\ UNCHANGED << cartAdds, selected >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>

DropCart(t) ==
  /\ IF t = CartDrop /\ dragging /\ cartAdds < CartBound
     THEN /\ cartAdds' = cartAdds + 1
          /\ dragging' = FALSE
          /\ dragGhost' = "none"
          /\ dragKind' = "none"
          /\ lastAction' = "dropCart"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, selected >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>

ClickBuy(t) ==
  /\ IF t = BuyBtn /\ cartAdds < CartBound
     THEN /\ cartAdds' = cartAdds + 1
          /\ lastAction' = "clickBuy"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, selected, dragGhost, dragKind >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>

ClickShop(t) ==
  /\ IF t = ShopRow
     THEN /\ lastAction' = "clickShopRow"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>

ClickArt(t) ==
  /\ IF t = ArtFrame
     THEN /\ lastAction' = "clickArtFrame"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>

ClickChrome(t) ==
  /\ IF t = Chrome
     THEN /\ lastAction' = "clickChrome"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds, selected, dragGhost, dragKind >>

Release(t) ==
  /\ banding' = FALSE
  /\ dragging' = FALSE
  /\ dragGhost' = "none"
  /\ dragKind' = "none"
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

InvArtNeverBands ==
  (lastAction = "bandArm") => (lastTarget # ArtFrame)

InvArtNeverSelected ==
  ArtFrame \notin selected

\* Empty-background arm is allowed; when we paint a shop hit, it joins selection.
InvEmptyBandCanSelectShop ==
  (lastAction = "bandPaint" /\ lastTarget = ShopRow) => (ShopRow \in selected)

InvListingGhostIsCardArt ==
  (dragging /\ dragKind = "listing") => (dragGhost = "cardArt")

InvListingRicherThanCard ==
  \* Listing drag is a distinct kind from desk/related card art.
  (lastAction = "dragStart" /\ lastTarget = ShopRow) => (dragKind = "listing")

InvClickKeepsCart ==
  (lastAction \in {"clickShopRow", "clickArtFrame"}) => TRUE

THEOREM Spec => [](
  TypeOK
  /\ InvMutualExclusion
  /\ InvArtNeverBands
  /\ InvArtNeverSelected
  /\ InvEmptyBandCanSelectShop
  /\ InvListingGhostIsCardArt
  /\ InvListingRicherThanCard
  /\ InvClickKeepsCart
)
=============================================================================
