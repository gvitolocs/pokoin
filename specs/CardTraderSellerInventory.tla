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
    saleHappened = FALSE;

  define {
    TypeOK ==
      /\ ctQty \in 0..MaxQty
      /\ pokoinQty \in 0..MaxQty
      /\ webhookRegistered \in BOOLEAN
      /\ webhookPending \in BOOLEAN
      /\ reconcileDue \in BOOLEAN
      /\ saleHappened \in BOOLEAN

    NoStaleAfterObservation ==
      (saleHappened /\ ~reconcileDue /\ ~webhookPending) => pokoinQty = ctQty

    SoldEventuallyRemoved == saleHappened ~> pokoinQty = 0
  }

  fair process (Seller = "seller") {
    Sell:
      await ~saleHappened;
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
\* BEGIN TRANSLATION (chksum(pcal) = "aa5d5fd4" /\ chksum(tla) = "5a2c55f9")
VARIABLES ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened, pc

(* define statement *)
TypeOK ==
  /\ ctQty \in 0..MaxQty
  /\ pokoinQty \in 0..MaxQty
  /\ webhookRegistered \in BOOLEAN
  /\ webhookPending \in BOOLEAN
  /\ reconcileDue \in BOOLEAN
  /\ saleHappened \in BOOLEAN

NoStaleAfterObservation ==
  (saleHappened /\ ~reconcileDue /\ ~webhookPending) => pokoinQty = ctQty

SoldEventuallyRemoved == saleHappened ~> pokoinQty = 0


vars == << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened, pc >>

ProcSet == {"seller"} \cup {"webhook"} \cup {"reconciler"} \cup {"repair"}

Init == (* Global variables *)
        /\ ctQty = MaxQty
        /\ pokoinQty = MaxQty
        /\ webhookRegistered = FALSE
        /\ webhookPending = FALSE
        /\ reconcileDue = FALSE
        /\ saleHappened = FALSE
        /\ pc = [self \in ProcSet |-> CASE self = "seller" -> "Sell"
                                        [] self = "webhook" -> "WaitForWebhook"
                                        [] self = "reconciler" -> "WaitForReconcile"
                                        [] self = "repair" -> "RepairRegistration"]

Sell == /\ pc["seller"] = "Sell"
        /\ ~saleHappened
        /\ ctQty' = 0
        /\ saleHappened' = TRUE
        /\ reconcileDue' = TRUE
        /\ IF webhookRegistered
              THEN /\ webhookPending' = TRUE
              ELSE /\ TRUE
                   /\ UNCHANGED webhookPending
        /\ pc' = [pc EXCEPT !["seller"] = "SellerDone"]
        /\ UNCHANGED << pokoinQty, webhookRegistered >>

SellerDone == /\ pc["seller"] = "SellerDone"
              /\ pc' = [pc EXCEPT !["seller"] = "SellerDone"]
              /\ UNCHANGED << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened >>

Seller == Sell \/ SellerDone

WaitForWebhook == /\ pc["webhook"] = "WaitForWebhook"
                  /\ webhookPending
                  /\ pc' = [pc EXCEPT !["webhook"] = "ApplyWebhook"]
                  /\ UNCHANGED << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened >>

ApplyWebhook == /\ pc["webhook"] = "ApplyWebhook"
                /\ pokoinQty' = ctQty
                /\ webhookPending' = FALSE
                /\ reconcileDue' = FALSE
                /\ pc' = [pc EXCEPT !["webhook"] = "WaitForWebhook"]
                /\ UNCHANGED << ctQty, webhookRegistered, saleHappened >>

Webhook == WaitForWebhook \/ ApplyWebhook

WaitForReconcile == /\ pc["reconciler"] = "WaitForReconcile"
                    /\ reconcileDue
                    /\ pc' = [pc EXCEPT !["reconciler"] = "ApplyCompleteExport"]
                    /\ UNCHANGED << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened >>

ApplyCompleteExport == /\ pc["reconciler"] = "ApplyCompleteExport"
                       /\ pokoinQty' = ctQty
                       /\ reconcileDue' = FALSE
                       /\ webhookPending' = FALSE
                       /\ pc' = [pc EXCEPT !["reconciler"] = "WaitForReconcile"]
                       /\ UNCHANGED << ctQty, webhookRegistered, saleHappened >>

Reconciler == WaitForReconcile \/ ApplyCompleteExport

RepairRegistration == /\ pc["repair"] = "RepairRegistration"
                      /\ webhookRegistered' = TRUE
                      /\ pc' = [pc EXCEPT !["repair"] = "RepairDone"]
                      /\ UNCHANGED << ctQty, pokoinQty, webhookPending, reconcileDue, saleHappened >>

RepairDone == /\ pc["repair"] = "RepairDone"
              /\ pc' = [pc EXCEPT !["repair"] = "RepairDone"]
              /\ UNCHANGED << ctQty, pokoinQty, webhookRegistered, webhookPending, reconcileDue, saleHappened >>

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
