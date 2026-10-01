-------------------------- MODULE SearchRanking --------------------------
(*
  Finite behavioural check of the actual shared scorer and live popup selector.
  check-search-ranking-tlc.sh runs the repository JavaScript over bounded cache
  permutations, then writes SearchRankingFixtures.tla into a temporary directory.
  The generated scores and outputs are observations, not hand-entered constants.

  Every TLC initial state picks one observed query / insertion order / cap. It
  replays that output one printing at a time and checks independent ordering,
  cardinality, identity and eligibility properties. This checks the bounded JS
  executions, not every possible Unicode query, catalog or network schedule.

  Regression modes intentionally reintroduce the previous penalty calculation
  or whole-group fill. Their configs must produce an invariant counterexample.
*)
EXTENDS Integers, Sequences, FiniteSets, TLC, SearchRankingFixtures

CONSTANT LegacyMode
VARIABLES chosen, cursor, displayed
vars == <<chosen, cursor, displayed>>

ObservedOutput == IF LegacyMode = "whole-group" THEN chosen.legacy ELSE chosen.actual
Row(id) == CHOOSE row \in chosen.rows : row.id = id
EligibleIds == {row.id : row \in {r \in chosen.rows : r.eligible}}
ShownIds == {displayed[i] : i \in 1..Len(displayed)}

Init ==
  /\ chosen \in Cases
  /\ cursor = 0
  /\ displayed = <<>>

AppendObserved ==
  /\ cursor < Len(ObservedOutput)
  /\ cursor' = cursor + 1
  /\ displayed' = Append(displayed, ObservedOutput[cursor + 1])
  /\ UNCHANGED chosen

Done == /\ cursor = Len(ObservedOutput) /\ UNCHANGED vars
Next == AppendObserved \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ LegacyMode \in {"current", "extra-tokens", "whole-group"}
  /\ chosen \in Cases
  /\ cursor \in 0..Len(ObservedOutput)
  /\ displayed \in Seq({row.id : row \in chosen.rows})
  /\ Len(displayed) = cursor

FullCoverageDominates ==
  cursor > 0 =>
    \A probe \in ScoreProbes : probe.fullCoverage > probe.partialCoverage
      /\ probe.fullScore > probe.partialScore

AllFixtureCoverageDominates ==
  \A a, b \in chosen.rows : a.coverage > b.coverage => a.score > b.score

AcceptedNameTypoBeatsMetadataPrefix ==
  cursor > 0 =>
    \A probe \in ScoreProbes : probe.typoCoverage = probe.metadataCoverage
      /\ probe.typoScore > probe.metadataScore

NameSpecificityUsesNameMatches ==
  cursor > 0 =>
    \A probe \in ScoreProbes :
      IF LegacyMode = "extra-tokens"
      THEN probe.oldBaseScore > probe.oldExtraScore
      ELSE probe.baseScore > probe.extraScore

NonIncreasingScores ==
  \A i, j \in 1..Len(displayed) :
    i < j => Row(displayed[i]).score >= Row(displayed[j]).score

WithinCap == Len(displayed) <= chosen.cap
UniquePrintings == Cardinality(ShownIds) = Len(displayed)
EligibleOnly == ShownIds \subseteq EligibleIds

(* Equal score ties must also be stable, as the exact observed reference is
   compared rather than accepting any arbitrary descending permutation. *)
CacheOrderIndependent ==
  cursor = Len(ObservedOutput) => displayed = chosen.reference

CompleteWhenSpace ==
  cursor = Len(ObservedOutput) =>
    Len(displayed) = IF Cardinality(EligibleIds) < chosen.cap
                    THEN Cardinality(EligibleIds) ELSE chosen.cap

(* Every selected printing is at least as relevant as any eligible printing
   omitted at the cap. This catches a cap selecting low rows before later high
   rows even if its short output happens to be nonincreasing. *)
TopEligibleScores ==
  cursor = Len(ObservedOutput) =>
    \A shown \in ShownIds, omitted \in EligibleIds \ ShownIds :
      Row(shown).score >= Row(omitted).score
=============================================================================
