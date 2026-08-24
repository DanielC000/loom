# 4cfb30fc — inbound MCP request dedup: does the replay path fire in practice?

Worker investigation, 2026-08-24. **Read-only, DoD-1 only per the card's own instruction — no production code changed.** `filesChanged` for this task is this document plus one read-only analysis script (`scripts/analyze-mcp-log.mjs`), run against the live `[mcp]` census instrument shipped by card `98c4a651` (merged `a9fa73d`). No log file was modified.

Card `4cfb30fc` guards against a transport-layer retry re-entering an MCP route as a fresh, independently-rooted request. Its DoD-1 asks: characterize the `[mcp]` corpus honestly, search for genuine replay evidence, pair any absence claim with a positive control, then give a verdict. All four are answered below, in order, with the evidence they rest on.

## Corpus

Read `$LOOM_HOME/logs/daemon-output.log` directly (no rotation involved — `.1` predates the instrument: `grep -ac '\[mcp\]' daemon-output.log.1` → 0). The `[mcp]` census starts at the exact daemon boot that deployed `a9fa73d` (v0.28.0, line 42928, `2026-08-23T13:16:06.150Z`) — one line later the first `[mcp]` line appears. Everything before that boot is out of scope and excluded by construction (nothing before it matches the `[mcp]` line pattern at all).

- **Window:** `2026-08-23T13:16:07.773Z` → `2026-08-24T05:28:45.209Z` (~16h13m, and growing — the file is live).
- **Total `[mcp]` lines:** 9274 (at time of last run; the log rotates on daemon restart and is being actively appended to, so re-running later will see a larger, superset window).
- **Daemon restarts inside this window: 7** — i.e. 7 separate process lifetimes. `mcpLogSeq` (the `seq=` field) is a module-level counter that resets to 0 on every restart, so `seq` is only comparable *within* one lifetime, never across a restart boundary. This is stated nowhere in the card or kickoff and is confirmed here from the log itself (`Loom daemon vX.Y.Z listening on …` boot markers interleaved with `[mcp]` lines).
- **Distinct sessionIds:** 85.
- **By router:** `task`=4433, `orchestration`=4293, `platform`=548. **Zero traffic on `audit`/`user-audit`/`setup`/`operator`/`run`** in this window — those 5 of the 8 instrumented routers are simply unexercised here; this corpus says nothing about them.
- **By method:** `server/discover`=1072, `initialize`=1074, `notifications/initialized`=1074, `tools/list`=1074, `tools/call`=1628, and 3352 lines with `method=-`.

## Classification (excluding two known false-positive generators, named up front)

| class | count | why excluded |
|---|---:|---|
| discover probes (`rpcId=server-discover-probe-1`) | 1072 | constant literal id shared by every client at connection start, carries no per-request identity |
| non-RPC transport calls (`method=-`) | 3352 | confirmed by reading the emitter's call site (`gateway/server.ts`, `app.all("/mcp/:sessionId", …)`): Fastify's `.all()` matches every HTTP verb, not just POST. The MCP streamable-HTTP transport also uses GET (open the SSE stream) and DELETE (terminate session) on the same route, and those carry no JSON-RPC body — so `req.body` is `undefined`, producing a line with `method=-`, `rpcId=-`, no `argsLen`/`argsHash` at all. These are real inbound requests but carry zero identity to dedup against. |
| **genuine JSON-RPC entries** | **4850** | the actual candidate pool |

`1072 + 3352 + 4850 = 9274` — reconciles exactly with the total.

Genuine JSON-RPC entries by method: `initialize`=1074, `notifications/initialized`=1074, `tools/list`=1074, `tools/call`=1628. By router: `task`=2198, `orchestration`=2359, `platform`=293.

## Positive controls (run before trusting any zero below)

**Control 1 — known-duplicated identity, left in on purpose.** Grouping the *excluded* discover-probe set by `(sessionId,router,rpcId,tool,argsHash)` yields 134 groups with >1 entry (of 170 total), covering 1036 lines — **PASS**. This proves the grouping/parse pipeline is not silently broken; it finds a duplicate when one is known to exist.

**Control 2 — synthetic injection.** Took one currently-unique `tools/call` row (`…|task|2|memory_read|5b81439b90`), cloned it with a different `seq`, re-ran the grouping — group size went from 1 → 2 as expected. **PASS.**

(An earlier pass of this control failed with group size 0 — not because the pipeline is broken, but because the injected-row key string had drifted out of sync with the grouping function's own key format after `tool` was added to it. Fixed and re-verified before trusting anything downstream. Recorded here per the standing "prove your check can fail" discipline — the failure was real, in the harness, and worth being honest about.)

## A third false-positive generator, found empirically (not named by the card)

An initial run keyed only on `(sessionId, router, rpcId, argsHash)` — matching the kickoff's suggested tuple literally — found what looked like a duplicate: the same session, router, and rpcId, but **two different tool names** (`my_context` and `gate_queue`), an hour apart, sharing one `argsHash`. Reason: `argsHash` hashes only `params.arguments`, and most maintenance tools (`my_context`, `gate_queue`, `worker_list`, `inbox_pull`, `question_pull`, `served_status`, …) take **no arguments**, so they all serialize to `{}`/`undefined` and collide on the same hash regardless of which tool was actually called. **Fix: `tool` must be part of the identity key.** Re-running with `tool` included, that spurious pairing disappears (25 groups instead of the tool-less run's larger count). This is documented in the script's key-construction comment so a future reader doesn't rediscover it the hard way.

## Replay search 1 — same rpcId, matched identity

Grouping all 4850 genuine JSON-RPC entries by `(sessionId, router, rpcId, tool, argsHash)`: **427 identity tuples with >1 occurrence**, covering 3170 of 4850 lines. Broken down by method, this is **overwhelmingly `initialize`/`notifications/initialized`/`tools/list` (134 groups each)**, and only **25 groups (56 lines) on `tools/call`** — the only method that carries a real per-call argument identity.

Why the `initialize`/`notifications/initialized` count is so large and *not* interesting: `initialize` and `notifications/initialized` carry no `arguments` field (argsHash is always null), and `rpcId` there is confirmed (see "What `rpcId` actually is" below) to be a **small per-connection counter minted by the client**, reset to a low integer on every fresh MCP connection. Reading one session's full line sequence (`5db71873…`) shows a `server/discover` → `initialize(rpcId=0)` → `notifications/initialized` → `tools/list(rpcId=1)` handshake repeating every ~15 minutes for the life of the session — a reconnect cadence, not a retry. Any two reconnects from the same session legitimately reuse `rpcId=0`/`1` every time, so grouping on rpcId alone is guaranteed to "find" hundreds of these — they are not evidence of anything.

**The tools/call-only search is the one that actually matters.** Restricting to the 1628 `tools/call` entries (the only ones with a real `argsHash` derived from real arguments): **25 identity tuples with >1 occurrence, covering 56 of 1628 lines out of 1597 distinct tuples.**

**Time-adjacency check on those 25 groups** (a genuine transport retry re-enters within the same connection attempt — sub-second to low-single-digit seconds, adjacent `seq`; a coincidental rpcId reuse from a fresh reconnect looks the opposite): the **smallest** time gap found across *all 25 groups* is **17.6 minutes**, with a **182-line `seq` gap** (182 other `[mcp]` lines from other sessions occurred between the two). Every one of the 25 groups is minutes-to-hours apart with a large intervening seq gap. This is the signature of the *same session* reconnecting (client mints a fresh low `rpcId`) and re-issuing the same no-arg maintenance call (`inbox_pull`, `worker_list`, `gate_queue`, `question_pull`, `tasks_list`, `tasks_get`, `list_all_tasks`, `list_all_sessions`, `served_status`) on its next periodic wake — **not** a retry.

## What `rpcId` actually is (read from the merged source, per the card's own instruction — not inferred from the log)

`packages/daemon/src/mcp/inbound-log.ts` (`a9fa73d`):
```ts
const rpcId = rpc?.id === undefined || rpc?.id === null ? "-" : String(rpc.id);
```
`rpc.id` is `entry.id` — the raw JSON-RPC `id` field from the parsed request body. **It is entirely client-supplied**, not a daemon-generated nonce. It is not logged, checked, or constrained anywhere in the emitter. This confirms the card's own hedge ("if rpcId turns out to be client-supplied and resettable, say so plainly, because that bounds what the log can prove") — it is exactly that, and the log evidence above (rpcId resetting to 0/1 on every reconnect) demonstrates the practical consequence: **a dedup cache keyed on `(sessionId, rpcId)` is only meaningful within one MCP connection's lifetime.** Pooling across reconnects (as a naive implementation might) reintroduces the exact false-positive shape found and excluded above.

## Replay search 2 — rpcId-agnostic, time-windowed (the card's actual concern)

The card's real worry is **not** "the same rpcId comes twice" — it's a retry that **mints a fresh, unrelated rpcId** (structurally invisible to any id-based tag) but fires the same semantic action again. Proxy for that: group by `(sessionId, router, tool, argsHash)` **ignoring rpcId**, and look for any two entries within a short wall-clock window (30s — generous, well inside "looks like an immediate double-fire" and far below the 17.6-minute floor already established above).

Result: **16 pairs found within 30s.** All 16, without exception, involve two **different, sequentially-incrementing** `rpcId`s within one continuous connection (e.g. `rpcId=30` then `rpcId=32` 23s later; `rpcId=4,5,6,8,9` climbing over two minutes on `gate_status`). This is the exact opposite signature of a retry: a genuine retry **resends the identical request object, id included**; a fresh, intentionally-minted request gets its own new id. Every one of these 16 is explained by ordinary intentional polling — the `/worker`/`/orchestrate` doctrine itself instructs exactly this pattern ("poll `gate_status` on your own opId", "check `worker_list`/`gate_queue` periodically while parked") — not by any transport mechanism. **Zero pairs anywhere in the corpus show same-rpcId-and-close-in-time (search 1) or fresh-rpcId-but-suspiciously-immediate (search 2) in a way not fully explained by legitimate reconnect or poll-loop behavior.**

## Highest-privilege router (`/mcp-platform`)

`platform` router: 548 total lines, 293 genuine JSON-RPC, 107 `tools/call` entries. **4 of those 107 fall into duplicate identity tuples** — same reconnect-shaped pattern as above (e.g. `list_all_tasks`/`question_pull`/`list_all_sessions` re-issued by the same session ~2 hours apart, 3 times, matching a periodic wake cadence). No close-in-time pair. Tool distribution: `project_task_update`=26, `list_all_tasks`=19, `idle_report`=17, `project_task_get`=16, `session_message`=13, `project_task_create`=6, `list_all_sessions`=4, `question_pull`=4, `recycle_me`=1, `session_transcript`=1. **No replay evidence on the highest-privilege route either.**

## Verdict

**(b) — the retry/replay path does not fire in a corpus of this size and shape.** Two independent search strategies (same-rpcId identity match; rpcId-agnostic time-window match), each backed by a passing positive control, found zero instances shaped like a genuine transport-layer retry anywhere in 4850 genuine JSON-RPC requests across 85 sessions and 16+ hours, including on the highest-privilege router.

**What this does and does not rule out, stated plainly:**
- It does **not** rule out the mechanism existing — it rules out the mechanism having **fired** in this window. 16 hours, one host, mostly-idle-to-moderate agent traffic is not an exhaustive search.
- Every route here is **loopback** (`127.0.0.1`) — the classic motivating scenario for this card (a proxy replay, a flaky network hop causing a client-side retry) has structurally less surface to occur on localhost than it would over a real network. If Loom's MCP transport ever crosses a real network boundary, this corpus says nothing about that future exposure.
- 5 of the 8 instrumented routers (`audit`, `user-audit`, `setup`, `operator`, `run`) carried **zero** traffic in this window — this corpus says nothing about them at all.
- `rpcId` is confirmed client-supplied and connection-scoped (see above) — this bounds what *any* rpcId-based dedup cache could reliably do, and is itself a finding worth carrying into any future implementation: a cache must not pool `rpcId` across reconnects, or it inherits the same false-positive shape found and excluded here.
- Per the card's own §HONEST SCOPE: this analysis does not touch, explain, or attribute the two duplicates actually observed in the past (`[loom:prompt-mismatch]` gen=28, and the gen=26 composer-accumulation case) — both were independently diagnosed as different mechanisms and neither shows up in this corpus as this card's failure mode. Nothing above should be read as newly implicating or clearing this card in either incident.

**Recommendation: downgrade, don't hard-close.** The corpus is real evidence the path is not firing in practice under the conditions Loom currently runs in (loopback transport, the traffic mix seen here), which weakens the case for building the dedup cache now — but the structural blind spot the card describes (a genuine transport retry is definitionally invisible to downstream tagging) is still true by construction, and the corpus is too short and too narrow (one host, one 16h window, 5 of 8 routers silent) to certify it can never occur. If the daemon's transport model changes (a real network hop, a reverse proxy in front of the gateway), this evidence stops applying and the card should be re-evaluated fresh, not carried forward as "already investigated."

## Reproduce

```
node docs/investigations/4cfb30fc-mcp-inbound-replay-search/scripts/analyze-mcp-log.mjs "$LOOM_HOME/logs/daemon-output.log"
```

The log is live and append-only across daemon restarts (rotating only past a size threshold), so a later run will see a superset window with more restarts and more traffic — the accounting/exclusion logic is written to be re-run safely at any time, not a one-shot snapshot.
