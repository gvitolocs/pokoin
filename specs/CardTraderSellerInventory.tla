-------------------- MODULE CardTraderSellerInventory --------------------
EXTENDS Naturals

CONSTANT MaxQty

(*
--algorithm SellerInventory {
  variables
    ctQty = MaxQty,
    pokoinQty = MaxQty,
    webhookRegistered = FALSE,
    webhookPending = FALSE,
    reconcileDue = FALSE,
    saleHappened = FALSE,
    cardTraderSoldQty = 0,
    nativeSoldQty = 0;

  define {
    TypeOK ==
      /\ ctQty \in 0..MaxQty
      /\ pokoinQty \in 0..MaxQty
      /\ webhookRegistered \in BOOLEAN
      /\ webhookPending \in BOOLEAN
      /\ reconcileDue \in BOOLEAN
      /\ saleHappened \in BOOLEAN
      /\ cardTraderSoldQty \in 0..MaxQty
      /\ nativeSoldQty \in 0..MaxQty

    NoStaleAfterObservation ==
      (saleHappened /\ ~reconcileDue /\ ~webhookPending) => pokoinQty = ctQty

    NoDoubleCount ==
      /\ nativeSoldQty = 0
      /\ (saleHappened => cardTraderSoldQty = MaxQty)

    SoldEventuallyRemoved == saleHappened ~> pokoinQty = 0
  }

  fair process (Seller = "seller") {
    Sell:
      await ~saleHappened;
      cardTraderSoldQty := cardTraderSoldQty + ctQty;
      ctQty := 0;
      saleHappened := TRUE;
      reconcileDue := TRUE;
      if (webhookRegistered) {
        webhookPending := TRUE;
      };
    SellerDone:
      goto SellerDone;
  }

  fair process (Webhook = "webhook") {
    WaitForWebhook:
      await webhookPending;
    ApplyWebhook:
      pokoinQty := ctQty;
      webhookPending := FALSE;
      reconcileDue := FALSE;
      goto WaitForWebhook;
  }

  fair process (Reconciler = "reconciler") {
    WaitForReconcile:
      await reconcileDue;
    ApplyCompleteExport:
      pokoinQty := ctQty;
      reconcileDue := FALSE;
      webhookPending := FALSE;
      goto WaitForReconcile;
  }

  fair process (WebhookRepair = "repair") {
    RepairRegistration:
      webhookRegistered := TRUE;
    RepairDone:
      goto RepairDone;
  }
}
*)
\* BEGIN TRANSLATION (chksum(pcal) = "b42e8324" /\ chksum(tla) = "64dfeb6e")
VARIABLES ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened, cardTraderSoldQty, nativeSoldQty, pc

(* define statement *)
TypeOK ==
  /\ ctQty \in 0..MaxQty
  /\ pokoinQty \in 0..MaxQty
  /\ webhookRegistered \in BOOLEAN
  /\ webhookPending \in BOOLEAN
  /\ reconcileDue \in BOOLEAN
  /\ saleHappened \in BOOLEAN
  /\ cardTraderSoldQty \in 0..MaxQty
  /\ nativeSoldQty \in 0..MaxQty

NoStaleAfterObservation ==
  (saleHappened /\ ~reconcileDue /\ ~webhookPending) => pokoinQty = ctQty

NoDoubleCount ==
  /\ nativeSoldQty = 0
  /\ (saleHappened => cardTraderSoldQty = MaxQty)

SoldEventuallyRemoved == saleHappened ~> pokoinQty = 0


vars == << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened, cardTraderSoldQty, nativeSoldQty, pc >>

ProcSet == {"seller"} \cup {"webhook"} \cup {"reconciler"} \cup {"repair"}

Init == (* Global variables *)
        /\ ctQty = MaxQty
        /\ pokoinQty = MaxQty
        /\ webhookRegistered = FALSE
        /\ webhookPending = FALSE
        /\ reconcileDue = FALSE
        /\ saleHappened = FALSE
        /\ cardTraderSoldQty = 0
        /\ nativeSoldQty = 0
        /\ pc = [self \in ProcSet |-> CASE self = "seller" -> "Sell"
                                        [] self = "webhook" -> "WaitForWebhook"
                                        [] self = "reconciler" -> "WaitForReconcile"
                                        [] self = "repair" -> "RepairRegistration"]

Sell == /\ pc["seller"] = "Sell"
        /\ ~saleHappened
        /\ cardTraderSoldQty' = cardTraderSoldQty + ctQty
        /\ ctQty' = 0
        /\ saleHappened' = TRUE
        /\ reconcileDue' = TRUE
        /\ IF webhookRegistered
              THEN /\ webhookPending' = TRUE
              ELSE /\ TRUE
                   /\ UNCHANGED webhookPending
        /\ pc' = [pc EXCEPT !["seller"] = "SellerDone"]
        /\ UNCHANGED << pokoinQty, webhookRegistered, nativeSoldQty >>

SellerDone == /\ pc["seller"] = "SellerDone"
              /\ pc' = [pc EXCEPT !["seller"] = "SellerDone"]
              /\ UNCHANGED << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened, cardTraderSoldQty, nativeSoldQty >>

Seller == Sell \/ SellerDone

WaitForWebhook == /\ pc["webhook"] = "WaitForWebhook"
                  /\ webhookPending
                  /\ pc' = [pc EXCEPT !["webhook"] = "ApplyWebhook"]
                  /\ UNCHANGED << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened, cardTraderSoldQty, nativeSoldQty >>

ApplyWebhook == /\ pc["webhook"] = "ApplyWebhook"
                /\ pokoinQty' = ctQty
                /\ webhookPending' = FALSE
                /\ reconcileDue' = FALSE
                /\ pc' = [pc EXCEPT !["webhook"] = "WaitForWebhook"]
                /\ UNCHANGED << ctQty, webhookRegistered, saleHappened, cardTraderSoldQty, nativeSoldQty >>

Webhook == WaitForWebhook \/ ApplyWebhook

WaitForReconcile == /\ pc["reconciler"] = "WaitForReconcile"
                    /\ reconcileDue
                    /\ pc' = [pc EXCEPT !["reconciler"] = "ApplyCompleteExport"]
                    /\ UNCHANGED << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened, cardTraderSoldQty, nativeSoldQty >>

ApplyCompleteExport == /\ pc["reconciler"] = "ApplyCompleteExport"
                       /\ pokoinQty' = ctQty
                       /\ reconcileDue' = FALSE
                       /\ webhookPending' = FALSE
                       /\ pc' = [pc EXCEPT !["reconciler"] = "WaitForReconcile"]
                       /\ UNCHANGED << ctQty, webhookRegistered, saleHappened, cardTraderSoldQty, nativeSoldQty >>

Reconciler == WaitForReconcile \/ ApplyCompleteExport

RepairRegistration == /\ pc["repair"] = "RepairRegistration"
                      /\ webhookRegistered' = TRUE
                      /\ pc' = [pc EXCEPT !["repair"] = "RepairDone"]
                      /\ UNCHANGED << ctQty, pokoinQty, webhookPending, reconcileDue, saleHappened, cardTraderSoldQty, nativeSoldQty >>

RepairDone == /\ pc["repair"] = "RepairDone"
              /\ pc' = [pc EXCEPT !["repair"] = "RepairDone"]
              /\ UNCHANGED << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened, cardTraderSoldQty, nativeSoldQty >>

WebhookRepair == RepairRegistration \/ RepairDone

(* Allow infinite stuttering to prevent deadlock on termination. *)
Terminating == /\ \A self \in ProcSet: pc[self] = "Done"
               /\ UNCHANGED vars

Next == Seller \/ Webhook \/ Reconciler \/ WebhookRepair
           \/ Terminating

Spec == /\ Init /\ [][Next]_vars
        /\ WF_vars(Seller)
        /\ WF_vars(Webhook)
        /\ WF_vars(Reconciler)
        /\ WF_vars(WebhookRepair)

Termination == <>(\A self \in ProcSet: pc[self] = "Done")

\* END TRANSLATION

=============================================================================
