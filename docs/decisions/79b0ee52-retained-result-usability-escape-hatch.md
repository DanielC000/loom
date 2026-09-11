# 79b0ee52 — a per-value escape hatch for a retained result that can self-declare its own staleness

## Narrative

The retained-view dedupe (card 33172f01) hands back a live `retained` hit UNCONDITIONALLY BY DEFAULT — right for a "merge" op, since there is no such thing as a merge outcome that's "settled but already known unusable"; the safety property there is entirely about not re-running against a torn-down worktree. `attach()`'s `opts.isRetainedResultUsable` is the per-value escape hatch for a kind whose own settled outcome CAN self-declare staleness — `run_gate`'s `headCurrent:false` (the worktree moved WHILE that run was executing) — so a caller already told a specific cached answer is contaminated is never handed that SAME answer again on the very next call. An `ok:false` (thrown error) retained hit is never gated by this predicate — an error carries no analogous staleness signal. Re-serving one is also the SAFER choice, not merely the default: for merge, a throw can strike after the squash already landed, so re-running risks compounding an unknown mid-mutation state; for gate, this window answers whether an already-kicked-off run finished, not whether to retry. This predicate only changes which VALUES pass the retained-hit check — it never touches the RUNNING-entry branch, so even a caller re-calling against a persistently-contaminated key can never mint two CONCURRENT real invocations; worst case is still exactly one real invocation in flight per `key` at a time.

The polarity here was inverted once more by card `ec994992`, on the SAME `isRetainedResultUsable` predicate: it states what IS usable rather than enumerating what isn't — only a value that actually ran, reached a real pass/fail verdict, and settled with a current HEAD is served from cache. A cancelled, never-ran, or tree-contaminated cache hit falls through to a genuinely fresh run instead, exactly like a real cache miss.

## Do not

- Do not gate an `ok:false` (thrown error) retained hit with `isRetainedResultUsable` — an error carries no analogous staleness signal, and re-serving it is the safer choice (a throw can strike mid-mutation; re-running risks compounding unknown state).
- Do not enumerate what ISN'T usable when extending `isRetainedResultUsable` — card `ec994992` inverted this predicate's polarity to state what IS usable instead, so a new, not-yet-considered contamination shape defaults to falling through to a fresh run rather than being silently served stale.

## Source

Inline comment in `packages/daemon/src/orchestration/pending-ops.ts` (the class doc's "RETAINED TERMINAL VIEW" closing paragraph): lines 288-293, as of commit `507e966583ff18068f5e7e56942acfe67001ee94`. Relocated by card `a1491009` (tranche 1); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `*` comment markers.

The polarity-inversion paragraph above is from a second site citing this card together with `ec994992`: `runWorkerGate`'s own JSDoc in `packages/daemon/src/sessions/service.ts` (tranche 61, ~lines 15506-15521 as of this tranche's HEAD).
