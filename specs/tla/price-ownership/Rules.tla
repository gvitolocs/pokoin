---------------------------- MODULE Rules ----------------------------
(***************************************************************************)
(* The group rule of a hand-made listing write, shared by Model.tla and    *)
(* the conformance table (MoveTable.tla → conformance/move-table.txt) that *)
(* the Rust test `group_move_matches_the_model_table` checks               *)
(* (crates/commerce/src/handlers/pricer.rs `group_move`, `is_manual_price`).*)
(***************************************************************************)
EXTENDS Naturals

NoGroup == "none"

\* pricer.rs `is_manual_price`: a positive price that is not the stored one.
IsManual(p, stored) == p > 0 /\ p # stored

\* pricer.rs `group_move`. cur: the listing's group or NoGroup. named: the
\* write's `pricingGroupId`, "absent" (not sent), "null" (null or "") or a group.
Move(cur, named, manual) ==
    IF named = "null" THEN (IF cur # NoGroup THEN "leave" ELSE "keep")
    ELSE IF named = "absent" THEN (IF manual /\ cur # NoGroup THEN "leave" ELSE "keep")
    ELSE IF named = cur THEN "keep" ELSE "join"
=============================================================================
