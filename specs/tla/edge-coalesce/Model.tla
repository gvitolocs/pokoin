------------------------------- MODULE Model -------------------------------
(***************************************************************************)
(* Edge request coalescing for one cache key (pokoin-rust/crates/edge/src/ *)
(* edge.rs, PR #307): `serve_cacheable`, `start_flight`, `lead`, `follow`, *)
(* the `FlightGuard` and the stale-while-revalidate background refresh.    *)
(*                                                                         *)
(* Keys are independent (one `flights` entry each), so one key is enough.  *)
(* Every client request and every background refresh is a one-shot         *)
(* process; the watch channel a leader creates is identified by its        *)
(* leader, so `chan[p]` is the value of p's channel and `flight` is the    *)
(* leader whose channel the `flights` map holds (None when the key is free)*)
(*                                                                         *)
(* Fixed = TRUE is origin/main after PR #307; Fixed = FALSE is the code    *)
(* before it (b472a910^1): no guard, no timeouts, 5xx not shared.          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Clients,        \* client requests for the key
    Bg,             \* background stale refreshes (tokio::spawn'ed leaders)
    None,           \* no leader / no channel
    Fixed,          \* TRUE: PR #307 (FlightGuard, timeouts, 5xx shared)
    Timeouts,       \* POKOIN_API_FLIGHT_TIMEOUT_SECS can fire (leader and follower)
    UpstreamHangs,  \* the API handler may never answer
    MaxHangUps,     \* clients that disconnect mid-request
    MaxPanics,      \* edge-code panics inside a leader
    InitCache       \* "empty", "fresh" or "stale"

Procs == Clients \cup Bg

\* Values of a watch channel (`enum Flight`).
Outcomes == {"pending", "entry", "error", "uncacheable", "abandoned", "failed502", "failed504"}

\* What a client finally got.
Answers == {"none", "hit", "stale", "miss", "coalesced", "coalesced5xx", "bypass",
            "own", "502", "504", "500", "reset"}

\* What an upstream answer can be: a cacheable 200, a non-storable answer
\* (personal, 4xx, no-store), a 5xx (handler error or caught handler panic),
\* or a body that fails to read.
Upstream == {"ok", "nostore", "5xx", "bodyerr"}

VARIABLES
    pc,        \* process control state
    flight,    \* leader whose channel is in `flights` (None = key free)
    chan,      \* chan[p]: value of the channel p created when it led
    mine,      \* mine[p]: the channel p leads or follows
    settleOut, \* outcome a leader has removed from `flights` but not yet sent
    hangs,     \* hangs[p]: this upstream call never answers
    cache,     \* "empty", "fresh", "stale"
    stored,    \* ghost: kinds of upstream answer ever written to the cache
    ans,       \* ans[p]: the answer the client got
    hangUps, panics,
    leads,     \* ghost: leads[p] = how many flights p has led
    followed   \* ghost: clients that have followed a flight

vars == <<pc, flight, chan, mine, settleOut, hangs, cache, stored, ans, hangUps, panics, leads, followed>>

PCs == {"init", "start", "fetch", "send", "follow", "forward", "done", "gone"}

TypeOK ==
    /\ pc \in [Procs -> PCs]
    /\ flight \in Procs \cup {None}
    /\ chan \in [Procs -> Outcomes]
    /\ mine \in [Procs -> Procs \cup {None}]
    /\ settleOut \in [Procs -> Outcomes]
    /\ hangs \in [Procs -> BOOLEAN]
    /\ cache \in {"empty", "fresh", "stale"}
    /\ stored \subseteq Upstream
    /\ ans \in [Procs -> Answers]
    /\ hangUps \in 0..MaxHangUps /\ panics \in 0..MaxPanics
    /\ leads \in [Procs -> 0..2]
    /\ followed \subseteq Clients

Init ==
    /\ pc = [p \in Procs |-> IF p \in Clients THEN "init" ELSE "done"]
    /\ flight = None
    /\ chan = [p \in Procs |-> "pending"]
    /\ mine = [p \in Procs |-> None]
    /\ settleOut = [p \in Procs |-> "pending"]
    /\ hangs = [p \in Procs |-> FALSE]
    /\ cache \in InitCache
    /\ stored = {}
    /\ ans = [p \in Procs |-> "none"]
    /\ hangUps = 0 /\ panics = 0
    /\ leads = [p \in Procs |-> 0]
    /\ followed = {}

\* Background processes are "done" until a stale hit spawns them; a spawned
\* one is marked by leads[b] = 1 so it is spawned at most once.
FreeBg == {b \in Bg : leads[b] = 0}

\* `start_flight` registering p as the leader: a new channel, in `flights`.
BecomeLeader(p) ==
    /\ flight' = p
    /\ chan' = [chan EXCEPT ![p] = "pending"]
    /\ mine' = [mine EXCEPT ![p] = p]
    /\ \E h \in IF UpstreamHangs THEN BOOLEAN ELSE {FALSE} : hangs' = [hangs EXCEPT ![p] = h]
    /\ leads' = [leads EXCEPT ![p] = @ + 1]

-----------------------------------------------------------------------------
(* serve_cacheable: cache lookup.                                          *)

Lookup(c) ==
    /\ pc[c] = "init"
    /\ CASE cache = "fresh" ->
              /\ pc' = [pc EXCEPT ![c] = "done"] /\ ans' = [ans EXCEPT ![c] = "hit"]
              /\ UNCHANGED <<flight, chan, mine, hangs, leads, followed>>
         [] cache = "stale" ->
              \* Answer STALE now. Fixed: start_flight here, spawn the leader.
              \* Before #307 the spawned task called start_flight itself; the
              \* outcome is the same.
              /\ ans' = [ans EXCEPT ![c] = "stale"]
              /\ IF flight = None /\ FreeBg # {}
                   THEN \E b \in FreeBg :
                          /\ BecomeLeader(b)
                          /\ pc' = [pc EXCEPT ![c] = "done", ![b] = "fetch"]
                   ELSE /\ pc' = [pc EXCEPT ![c] = "done"]
                        /\ UNCHANGED <<flight, chan, mine, hangs, leads, followed>>
         [] cache = "empty" ->
              /\ pc' = [pc EXCEPT ![c] = "start"]
              /\ UNCHANGED <<flight, chan, mine, hangs, ans, leads, followed>>
    /\ UNCHANGED <<settleOut, cache, stored, hangUps, panics, followed>>

\* start_flight: lead the key, or follow the running flight.
Start(c) ==
    /\ pc[c] = "start"
    /\ IF flight = None
         THEN /\ BecomeLeader(c)
              /\ pc' = [pc EXCEPT ![c] = "fetch"]
         ELSE /\ mine' = [mine EXCEPT ![c] = flight]
              /\ pc' = [pc EXCEPT ![c] = "follow"]
              /\ UNCHANGED <<flight, chan, hangs, leads>>
    /\ followed' = IF flight = None THEN followed ELSE followed \cup {c}
    /\ UNCHANGED <<settleOut, cache, stored, ans, hangUps, panics>>

-----------------------------------------------------------------------------
(* The leader. `Settle` is FlightGuard::settle (and finish_flight before   *)
(* #307): remove the key from `flights` under its lock, then send.         *)

\* Leader p takes its key out of `flights` and will send `out`.
Settle(p, out, answer) ==
    /\ flight' = IF flight = p THEN None ELSE flight
    /\ settleOut' = [settleOut EXCEPT ![p] = out]
    /\ pc' = [pc EXCEPT ![p] = "send"]
    /\ ans' = [ans EXCEPT ![p] = IF p \in Clients THEN answer ELSE "none"]

\* The upstream answered (or its body was read) in time.
Answer(p) ==
    /\ pc[p] = "fetch" /\ ~hangs[p]
    /\ \E u \in Upstream :
         CASE u = "ok" ->
                /\ cache' = "fresh"
                /\ stored' = stored \cup {u}
                /\ Settle(p, "entry", "miss")
           [] u = "nostore" ->
                /\ UNCHANGED <<cache, stored>>
                /\ Settle(p, "uncacheable", "bypass")
           [] u = "5xx" ->
                \* Fixed: shared with the followers, never stored.
                \* Before: no cache policy, so `Uncacheable` (followers refetch).
                /\ UNCHANGED <<cache, stored>>
                /\ Settle(p, IF Fixed THEN "error" ELSE "uncacheable", "bypass")
           [] u = "bodyerr" ->
                /\ UNCHANGED <<cache, stored>>
                /\ Settle(p, "failed502", "502")
    /\ UNCHANGED <<chan, mine, hangs, hangUps, panics, leads, followed>>

\* timeout_at(deadline, ...) in `lead` (head or body): 504 to everyone.
LeadTimeout(p) ==
    /\ Fixed /\ Timeouts
    /\ pc[p] = "fetch"
    /\ Settle(p, "failed504", "504")
    /\ UNCHANGED <<chan, mine, hangs, cache, stored, hangUps, panics, leads, followed>>

\* A panic in edge code while p leads. Fixed: FlightGuard::drop sees
\* `thread::panicking()` and sends Failed(502); the catch_panic layer gives
\* the client a 500. Before: the future unwinds, the entry stays in
\* `flights` with its sender, `Pending` forever.
LeaderPanic(p) ==
    /\ pc[p] = "fetch" /\ panics < MaxPanics
    /\ panics' = panics + 1
    /\ IF Fixed
         THEN Settle(p, "failed502", "500")
         ELSE /\ pc' = [pc EXCEPT ![p] = "gone"]
              /\ ans' = [ans EXCEPT ![p] = IF p \in Clients THEN "reset" ELSE "none"]
              /\ UNCHANGED <<flight, settleOut>>
    /\ UNCHANGED <<chan, mine, hangs, cache, stored, hangUps, leads, followed>>

\* The client of a leading request hangs up: axum drops the handler future.
\* Fixed: FlightGuard::drop (not panicking) sends Abandoned. Before: stuck.
\* Background refreshes are spawned tasks: nobody can hang them up.
LeaderHangUp(c) ==
    /\ c \in Clients /\ pc[c] = "fetch" /\ hangUps < MaxHangUps
    /\ hangUps' = hangUps + 1
    /\ IF Fixed
         THEN /\ flight' = IF flight = c THEN None ELSE flight
              /\ settleOut' = [settleOut EXCEPT ![c] = "abandoned"]
              /\ pc' = [pc EXCEPT ![c] = "send"]   \* drop still sends, then the task ends
         ELSE /\ pc' = [pc EXCEPT ![c] = "gone"]
              /\ UNCHANGED <<flight, settleOut>>
    /\ UNCHANGED <<chan, mine, hangs, cache, stored, ans, panics, leads, followed>>

\* The second half of settle: `tx.send(outcome)`.
Send(p) ==
    /\ pc[p] = "send"
    /\ chan' = [chan EXCEPT ![p] = settleOut[p]]
    /\ pc' = [pc EXCEPT ![p] = IF settleOut[p] = "abandoned" THEN "gone" ELSE "done"]
    /\ UNCHANGED <<flight, mine, settleOut, hangs, cache, stored, ans, hangUps, panics, leads, followed>>

-----------------------------------------------------------------------------
(* Followers (`follow` and the re-election loop in serve_cacheable).       *)

Receive(c) ==
    /\ pc[c] = "follow"
    /\ chan[mine[c]] # "pending"
    /\ LET o == chan[mine[c]] IN
         CASE o = "abandoned" ->   \* continue: start_flight again
                /\ pc' = [pc EXCEPT ![c] = "start"] /\ UNCHANGED ans
           [] o = "uncacheable" ->
                /\ pc' = [pc EXCEPT ![c] = "forward"] /\ UNCHANGED ans
           [] o \in {"entry", "error", "failed502", "failed504"} ->
                /\ pc' = [pc EXCEPT ![c] = "done"]
                /\ ans' = [ans EXCEPT ![c] =
                             CASE o = "entry" -> "coalesced"
                               [] o = "error" -> "coalesced5xx"
                               [] o = "failed502" -> "502"
                               [] o = "failed504" -> "504"]
    /\ UNCHANGED <<flight, chan, mine, settleOut, hangs, cache, stored, hangUps, panics, leads, followed>>

\* The follower's own deadline (Fixed only).
FollowTimeout(c) ==
    /\ Fixed /\ Timeouts
    /\ pc[c] = "follow"
    /\ pc' = [pc EXCEPT ![c] = "done"]
    /\ ans' = [ans EXCEPT ![c] = "504"]
    /\ UNCHANGED <<flight, chan, mine, settleOut, hangs, cache, stored, hangUps, panics, leads, followed>>

\* `forward_api`: the follower sends its own (uncacheable) request.
Forward(c) ==
    /\ pc[c] = "forward"
    /\ pc' = [pc EXCEPT ![c] = "done"]
    /\ ans' = [ans EXCEPT ![c] = "own"]
    /\ UNCHANGED <<flight, chan, mine, settleOut, hangs, cache, stored, hangUps, panics, leads, followed>>

\* A client that is not leading hangs up: only its own request ends.
OtherHangUp(c) ==
    /\ pc[c] \in {"follow", "forward"} /\ hangUps < MaxHangUps
    /\ hangUps' = hangUps + 1
    /\ pc' = [pc EXCEPT ![c] = "gone"]
    /\ UNCHANGED <<flight, chan, mine, settleOut, hangs, cache, stored, ans, panics, leads, followed>>

\* Time passes: a fresh entry goes stale, a stale one expires.
Age ==
    /\ cache # "empty"
    /\ cache' = IF cache = "fresh" THEN "stale" ELSE "empty"
    /\ UNCHANGED <<pc, flight, chan, mine, settleOut, hangs, stored, ans, hangUps, panics, leads, followed>>

-----------------------------------------------------------------------------

\* The steps a process takes on its own (fair).
Step(p) ==
    \/ p \in Clients /\ (Lookup(p) \/ Start(p) \/ Receive(p) \/ FollowTimeout(p) \/ Forward(p))
    \/ Answer(p) \/ LeadTimeout(p) \/ Send(p)

Next ==
    \/ \E p \in Procs : Step(p) \/ LeaderPanic(p)
    \/ \E c \in Clients : LeaderHangUp(c) \/ OtherHangUp(c)
    \/ Age

Sym == Permutations(Clients)

Spec == Init /\ [][Next]_vars /\ \A p \in Procs : WF_vars(Step(p))

-----------------------------------------------------------------------------
(* Properties                                                              *)

\* At most one leader per key, and it is the one `flights` names.
OneLeader == \A p \in Procs : pc[p] = "fetch" => flight = p

\* The key is never held by someone who is not fetching it.
NoOrphanFlight == flight # None => pc[flight] = "fetch"

\* No waiter is left pending after its leader ended for any reason: a
\* follower on a pending channel has a leader that is still fetching or
\* about to send.
NoStrandedFollower ==
    \A c \in Clients :
        (pc[c] = "follow" /\ chan[mine[c]] = "pending") => pc[mine[c]] \in {"fetch", "send"}

\* Only a cacheable 200 is ever written to the cache.
ErrorsNeverStored == stored \subseteq {"ok"}

\* Nobody is ever answered with "the leader went away".
Answered == \A c \in Clients : pc[c] = "done" => ans[c] # "none"

\* A request leads at most once, so its wait is bounded by one follow
\* deadline plus one lead deadline (see FINDINGS E1).
LeadsOnce == \A p \in Procs : leads[p] <= 1

\* Liveness: every request ends (answered, or its client went away).
EveryRequestEnds == \A c \in Clients : <>(pc[c] \in {"done", "gone"})

\* The key is eventually free again.
KeyFreed == <>[](flight = None)

-----------------------------------------------------------------------------
(* Witnesses: must be VIOLATED by the fixed model (the behaviour happens). *)

\* A follower whose leader hung up leads the key itself.
NeverReElected == ~\E c \in followed : leads[c] >= 1
NeverCoalesced5xx == \A c \in Clients : ans[c] # "coalesced5xx"
\* A background refresh replaces a stale entry.
NeverStaleRefresh == ~\E b \in Bg : leads[b] = 1 /\ pc[b] = "done" /\ cache = "fresh"
\* Followers of a panicking leader get the 502.
NeverFollower502 == \A c \in followed : ans[c] # "502"

=============================================================================
