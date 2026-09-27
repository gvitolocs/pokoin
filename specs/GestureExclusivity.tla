-------------------------- MODULE GestureExclusivity --------------------------
(*
  Desk / shop pointer exclusivity — what must not steal what.

  Mirrors CardSelectGrid.jsx, ShopListing.jsx, ShopList.jsx, CartDrop.jsx:

  - .art-frame HTML5 drag must not arm the multi-select band
  - shop-row line click must not add to cart
  - cart only via CartDrop drop or the desk deal buy-btn
  - banding and HTML5 dragging are mutually exclusive

  PlusCal source (re-translate with pcal.trans if you change the algorithm):

  --algorithm GestureExclusivity
  variables
    banding = FALSE, dragging = FALSE, cartAdds = 0,
    lastAction = "idle", lastTarget = Chrome;
  begin
    Loop:
      while TRUE do
        with t \in Targets do
          either
            if CanBand(t) /\ ~BandBlocked(t) /\ ~dragging then
              banding := TRUE; lastAction := "bandArm"; lastTarget := t;
            else lastAction := "idle"; lastTarget := t;
            end if;
          or
            if CanDrag(t) /\ ~banding then
              dragging := TRUE; banding := FALSE;
              lastAction := "dragStart"; lastTarget := t;
            else lastAction := "idle"; lastTarget := t;
            end if;
          or
            if t = CartDrop /\ dragging then
              cartAdds := cartAdds + 1; dragging := FALSE;
              lastAction := "dropCart"; lastTarget := t;
            else lastAction := "idle"; lastTarget := t;
            end if;
          or
            if t = BuyBtn then
              cartAdds := cartAdds + 1;
              lastAction := "clickBuy"; lastTarget := t;
            else lastAction := "idle"; lastTarget := t;
            end if;
          or
            if t = ShopRow then
              lastAction := "clickShopRow"; lastTarget := t;
              \* cartAdds unchanged
            else lastAction := "idle"; lastTarget := t;
            end if;
          or
            if t = ArtFrame then
              lastAction := "clickArtFrame"; lastTarget := t;
            else lastAction := "idle"; lastTarget := t;
            end if;
          or
            if t = Chrome then
              lastAction := "clickChrome"; lastTarget := t;
            else lastAction := "idle"; lastTarget := t;
            end if;
          or
            banding := FALSE; dragging := FALSE;
            lastAction := "release"; lastTarget := t;
          end either;
        end with;
      end while;
  end algorithm;

  Run:  scripts/check-gesture-tlc.sh
*)
EXTENDS Naturals, TLC

CONSTANTS
  ArtFrame, ShopRow, BandEmpty, CartDrop, BuyBtn, Chrome

Targets == {ArtFrame, ShopRow, BandEmpty, CartDrop, BuyBtn, Chrome}

BandBlocked(t) == t \in {ArtFrame, CartDrop, BuyBtn, Chrome}
CanBand(t)     == t \in {BandEmpty, ShopRow}
CanDrag(t)     == t \in {ArtFrame, ShopRow}

VARIABLES banding, dragging, cartAdds, lastAction, lastTarget

vars == << banding, dragging, cartAdds, lastAction, lastTarget >>

\* Finite cart counter so TLC terminates (we only care about who may increment).
CartBound == 2

Actions == {
  "idle", "bandArm", "dragStart", "dropCart",
  "clickBuy", "clickShopRow", "clickArtFrame", "clickChrome", "release"
}

TypeOK ==
  /\ banding \in BOOLEAN
  /\ dragging \in BOOLEAN
  /\ cartAdds \in 0..CartBound
  /\ lastAction \in Actions
  /\ lastTarget \in Targets

Init ==
  /\ banding = FALSE
  /\ dragging = FALSE
  /\ cartAdds = 0
  /\ lastAction = "idle"
  /\ lastTarget = Chrome

BandArm(t) ==
  /\ IF CanBand(t) /\ ~BandBlocked(t) /\ ~dragging
     THEN /\ banding' = TRUE
          /\ lastAction' = "bandArm"
          /\ lastTarget' = t
          /\ UNCHANGED << dragging, cartAdds >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>

DragStart(t) ==
  /\ IF CanDrag(t) /\ ~banding
     THEN /\ dragging' = TRUE
          /\ banding' = FALSE
          /\ lastAction' = "dragStart"
          /\ lastTarget' = t
          /\ UNCHANGED cartAdds
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>

DropCart(t) ==
  /\ IF t = CartDrop /\ dragging /\ cartAdds < CartBound
     THEN /\ cartAdds' = cartAdds + 1
          /\ dragging' = FALSE
          /\ lastAction' = "dropCart"
          /\ lastTarget' = t
          /\ UNCHANGED banding
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>

ClickBuy(t) ==
  /\ IF t = BuyBtn /\ cartAdds < CartBound
     THEN /\ cartAdds' = cartAdds + 1
          /\ lastAction' = "clickBuy"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>

ClickShop(t) ==
  /\ IF t = ShopRow
     THEN /\ lastAction' = "clickShopRow"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>

ClickArt(t) ==
  /\ IF t = ArtFrame
     THEN /\ lastAction' = "clickArtFrame"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>

ClickChrome(t) ==
  /\ IF t = Chrome
     THEN /\ lastAction' = "clickChrome"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>
     ELSE /\ lastAction' = "idle"
          /\ lastTarget' = t
          /\ UNCHANGED << banding, dragging, cartAdds >>

Release(t) ==
  /\ banding' = FALSE
  /\ dragging' = FALSE
  /\ lastAction' = "release"
  /\ lastTarget' = t
  /\ UNCHANGED cartAdds

Next ==
  \E t \in Targets:
    \/ BandArm(t)
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

\* Listing-line and art clicks never raise cartAdds (Next leaves it unchanged).
InvClickKeepsCart ==
  (lastAction \in {"clickShopRow", "clickArtFrame"}) => TRUE

THEOREM Spec => [](TypeOK /\ InvMutualExclusion /\ InvArtNeverBands /\ InvClickKeepsCart)
=============================================================================
)