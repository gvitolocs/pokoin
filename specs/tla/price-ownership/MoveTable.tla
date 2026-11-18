---------------------------- MODULE MoveTable ----------------------------
(***************************************************************************)
(* Prints the model's group rule (Rules.tla) for every input, one row a    *)
(* line, for the Rust conformance test. Regenerate (from this folder):     *)
(*   java -jar ~/.local/share/tla/tla2tools.jar -config conformance/MoveTable.cfg \ *)
(*     MoveTable.tla | grep '^<<' > conformance/move-table.txt             *)
(***************************************************************************)
EXTENDS Naturals, TLC, Rules

Cur == {NoGroup, "g1", "g2"}
Named == {"absent", "null", "g1", "g2"}

\* <<"move", cur, named, manual, result>>
MoveRows == {<<"move", c, n, m, Move(c, n, m)>> : c \in Cur, n \in Named, m \in BOOLEAN}
\* <<"manual", p, stored, result>>
ManualRows == {<<"manual", p, s, IsManual(p, s)>> : p \in 0..3, s \in 0..3}

ASSUME \A row \in MoveRows : PrintT(row)
ASSUME \A row \in ManualRows : PrintT(row)

VARIABLE done
Init == done = TRUE
Next == UNCHANGED done
=============================================================================
