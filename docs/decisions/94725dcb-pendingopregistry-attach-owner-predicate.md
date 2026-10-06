# 94725dcb — `PendingOpRegistry.attach()` takes a shared `OwnerCheck` predicate instead of per-site hand-rolled pre-checks

From Code Review `dbb5777e` of `656e326f` (commit `17d3e14f`), finding 3: `656e326f` enforced "only the
owning lineage may attach to an in-flight op" with hand-rolled pre-checks at three call sites, in two
shapes — merge compared the worker's parent lineage root; spawn and revive compared the op owner via
`peek()`. `merge_batch` and `run_gate` were deliberately left out, and every future `attach()` caller had
to remember its own pre-check by hand.

## The fix

`attach<T>()` gained a new parameter, `owner: OwnerCheck`:

```ts
export type OwnerCheck =
  | { exempt: true; reason: string }
  | { isOwner: (existing: PendingOpView | undefined) => boolean; refuse: (existing: PendingOpView | undefined) => unknown };
```

Evaluated by `attach()` itself at EVERY point it is about to serve or mint something: a running-entry
attach, an `untilSupersededVerdicts` cache hit, a TTL `retained` cache hit, or a genuinely fresh mint.
`existing` is the `PendingOpView` of whatever is about to be served, or `undefined` for a fresh mint (and
for the `untilSupersededVerdicts` path — see the limitation below). On `isOwner(existing) === false`,
`attach()` returns `{settled:true, ok:false, error: refuse(existing)}` instead of serving/minting.

## What each of the 5 real callers passes

- `spawnWorkerTracked`/`reviveWorkerTracked`: `foreignSpawnGuard`'s old pre-call logic (`peekAttachable` +
  `sameManagerLineage`) moved INSIDE a single shared factory, `SessionService.spawnOwnerCheck(managerSessionId,
  taskRef)` (Code Review M4) — both callers build their `owner` arg by calling it, so the two can never
  silently diverge. Its `isOwner`: `(existing) => !existing || sameManagerLineage(managerSessionId,
  existing.managerSessionId)`; its `refuse` builds a `ForeignSpawnInFlightError`. The old `peekAttachable`
  pre-call and `if (guard) return guard;` line are gone — `attach()`'s own internal cache lookup now feeds
  the predicate the identical `existing` value.
- `confirmWorkerMergeTracked`: `isOwner: () => sameManagerLineage(managerSessionId,
  db.getSession(workerSessionId)?.parentSessionId)`, ignoring `existing` entirely — `refuse: () => new
  NotYourWorkerError()`. The PRE-EXISTING hoisted lineage check at the top of the method (656e326f) is KEPT
  — it is not purely an attach-ownership check, it also gates two real side effects that run BEFORE
  `attach()` is ever reached: the dead-owner-eviction sweep (`evictDeadOwner`, a real mutation that
  force-removes a RUNNING entry) and the lineage-resolved predecessor-key walk. Deleting the hoist would let
  an unrelated-lineage caller trigger that eviction — a real mutation against someone else's in-flight op —
  before ever being refused. Both checks call the SAME `sameManagerLineage` helper, so there is one
  predicate, not two independent copies that can drift.
- `mergeBatchTracked`: `{ exempt: true, reason: "buildBatchDedupeKey embeds rootOf(managerSessionId) and
  rootOf(every resolved candidate workerSessionId); every candidate must EXACTLY belong to the caller (the
  per-candidate loop at the top of this method) before the key is even computed, so no foreign-lineage
  caller can ever reach attach() with a colliding key — proved by
  merge-batch-foreign-candidate-refused-before-attach.mjs" }`. Code Review (M1) found the first version of
  that test vacuous (its one "foreign" candidate had no branch, so the per-candidate loop's OWN NEXT check
  would have refused it even with the ownership comparison deleted or loosened to lineage) — fixed with
  TWO real-candidate scenarios, because one alone cannot discriminate both failure modes: an UNRELATED
  manager (catches the check being deleted; does NOT catch it being loosened to lineage, since an
  unrelated caller's lineage root differs either way) and a RECYCLED SUCCESSOR whose candidates are NOT
  yet reparented (catches the check being loosened to `sameManagerLineage`, since the successor's lineage
  root DOES match the predecessor's). The test also asserts `buildBatchDedupeKey` itself directly — the
  SAME candidate set produces a DIFFERENT key under the foreign manager than under the true owner.
  ⚠️ A SECOND Code Review round found that proving the two discriminations FOR REAL — deleting, then
  separately loosening, the real per-candidate check — must NEVER happen inside the committed test: the
  merge gate runs test files CONCURRENTLY, in several lanes, against the SAME worktree's `dist/`, so a
  test that mutates `src`/rebuilds `dist` at runtime corrupts every other test running in that worktree,
  and a crash mid-mutation leaves a broken tree behind for the rest of the gate. The committed test is
  READ-ONLY against whatever `dist/` already is — it asserts the two scenarios' refusal + the
  `buildBatchDedupeKey` difference + the spy-sanity negative control, nothing more. The two discriminating
  RED proofs were run ONCE, by hand (edit the one line, `pnpm build`, run a scratch verification script,
  observe, `git checkout HEAD --` the file, `pnpm build` again) — never re-executed by this file. Their
  output: deleting the check made BOTH scenarios reach `attach()` (0 → 1 `attachCalls` each); loosening it
  to `sameManagerLineage` left scenario A unchanged (still refused) and made ONLY scenario B reach
  `attach()` — confirming the two-scenario design actually discriminates both failure modes. See the
  card's own Code Review thread / worker_report for the full captured output.
- `runWorkerGate`: `{ exempt: true, reason: "gate kind has no separate owning manager — key
  (gate:<workerSessionId>) and caller (the worker's own session) are the same entity by construction" }`.

## RETAINED (settled) results vs ownership

A TTL `retained` view (`RetainedView extends PendingOpView`) carries a real `managerSessionId` — the owner
predicate applies to it exactly like a running entry (this is what closes 656e326f's Round 2 bug for
spawn/revive: a settled-but-still-attachable retained view now gets the identical check a running entry
does).

The `untilSupersededVerdicts` cache (merge/merge_batch only) stores `{rawOutcome, identity?}` — NO
`managerSessionId` at all. `existing` is therefore ALWAYS `undefined` at that one serve point, even though
something real is cached there. Harmless for merge/merge_batch today (neither predicate consults
`existing`), but a real, accepted, named limitation.

`pending-ops-registry.mjs` carries direct registry-level coverage of the owner check on EVERY serve point
(Code Review M2): a refusal on a running-entry attach, a TTL-retained hit (where `isOwner` DOES receive
the real settled `PendingOpView`), and an until-superseded hit (where it receives `undefined`, proving the
limitation above by direct observation rather than only by this prose) — plus the undefined/exempt
permissive paths, a real refusal, the negative-control allow case, a malformed (non-object) owner, and
(N1) a literal `null`/primitive owner failing closed rather than throwing.

## RUNTIME vs TYPE-SYSTEM enforcement (manager ruling, not my own call)

Making `owner` a required runtime parameter with no escape would have meant touching ~138 direct
`attach()`/`reg.attach()` call sites across the test corpus (overwhelmingly `pending-ops-registry.mjs`,
testing unrelated registry mechanics — retain/dedupe/identity-gating/cancel-veto/onSettle/etc., none of it
about ownership). A source-text scan was also rejected (fragile to a multi-line call or an aliased
import). The adopted split: `owner` is a REQUIRED TypeScript parameter — `tsc` refuses to build any
`packages/daemon/src/**` caller that omits it, which is the real, hard enforcement for every current and
future production caller (all of which are TypeScript). At RUNTIME, `owner === undefined` is treated as
the pre-this-card permissive path (no check at all) — reachable only from untyped `.mjs` test scaffolding,
never from a `tsc`-checked production caller. A present-but-malformed `owner` (anything other than a valid
`{exempt:true,...}` or `{isOwner,...}` shape) still fails closed — `undefined` is the ONLY value treated
as "no check requested".

`pending-op-registry-owner-required-typecheck.mjs` proves the TS half is real: a fixture `.ts` file that
omits `owner` fails to compile (`tsc --noEmit`), and the identical fixture with `owner` supplied compiles
clean. Code Review (M3) found the first version's RED fixture omitted `owner` AND `onSettledAfterPending`
AND `opts` all at once — it only "passed" because the generic "Expected N arguments" diagnostic matches
regardless of which trailing argument(s) are missing, so it would have stayed green even if `owner` alone
were optional. Fixed: the RED fixture now supplies `onSettledAfterPending`/`opts` explicitly as `undefined`
and omits ONLY `owner`. ⚠️ A second Code Review round found the DISCRIMINATING proof (confirming the
UNCHANGED red fixture compiles clean once `owner` is made optional) must NOT live inside the committed
test either, for the same reason as the merge_batch test above — never mutate `src`/rebuild `dist` from a
file the gate runs concurrently with other tests in the same worktree. Run ONCE, by hand (edit the one
line `owner: OwnerCheck,` → `owner?: OwnerCheck,`, `pnpm build`, recompile the same red fixture file,
observe, `git checkout HEAD --` the file, `pnpm build` again): the baseline red fixture failed with
`error TS2554: Expected 8 arguments, but got 7`; with `owner` made optional, the IDENTICAL fixture file
compiled clean. See the card's own Code Review thread / worker_report for the full captured output.

## Do not

- Do not call `attach()` from production code via a cast or `any` to dodge the required `owner` param —
  `undefined` at runtime is reachable only from untyped test scaffolding, never a sanctioned production
  escape hatch.
- Do not delete `confirmWorkerMergeTracked`'s hoisted lineage pre-check on the theory that `attach()`'s own
  `owner` predicate makes it redundant — it also gates the dead-owner-eviction sweep and the
  lineage-resolved predecessor-key walk, both of which run BEFORE `attach()` is ever called. Removing it
  would let an unrelated-lineage caller trigger a real mutation (evicting someone else's running op) before
  ever being refused.
- Do not add a `managerSessionId` field to `untilSupersededVerdicts` as a "quick fix" for the limitation
  above without re-reading `1555e361`'s own class-doc reasoning first — that cache's whole shape (no display
  fields, no owner, PROCESS-LOCAL) was deliberately minimal; a future caller that genuinely needs owner
  data from THAT path must extend it deliberately, not opportunistically, and must re-verify nothing else
  relies on its current minimal shape.
- Do not re-derive `foreignSpawnGuard`'s old logic a second time anywhere else — call
  `SessionService.spawnOwnerCheck(managerSessionId, taskRef)`, the one factory `spawnWorkerTracked`/
  `reviveWorkerTracked` both build their `owner` arg from.
- Do not widen the `mergeBatchTracked` exemption's reasoning without also updating/re-running
  `merge-batch-foreign-candidate-refused-before-attach.mjs` — if the per-candidate exact-match check this
  exemption leans on is ever loosened (to lineage-tolerant OR any other direction), that test's scenario B
  (or a new scenario added for the new direction) must go red, not silently stay green while the
  exemption's stated reasoning becomes false. A single "unrelated manager" scenario is NOT sufficient —
  see that test's own header for why.
- Do not treat a `null` `owner` the same as `undefined` — only the literal `undefined` (an omitted
  argument in untyped JS) is the permissive path; `null` and any other malformed value fail closed.
- Do not call `"exempt" in owner` (or any other `in` check) on `owner` without first guarding
  `typeof owner !== "object" || owner === null` (Code Review N1) — the `in` operator throws `TypeError` on
  a non-object right-hand side, so an un-guarded null or primitive owner would crash the caller instead of
  hitting the documented fail-closed refusal.
- Do not EVER have a committed test file edit `packages/daemon/src/**` or `dist/**` and rebuild at
  runtime, no matter how tempting it is as a way to "prove" a RED case — the merge gate runs test files
  CONCURRENTLY, in several lanes, against the SAME worktree's `dist/`; a test that mutates source corrupts
  every other test running in parallel in that worktree, and a crash mid-mutation leaves a broken tree
  behind for the rest of the gate. A RED proof that genuinely needs a different source state is a
  ONE-TIME, by-hand verification (or `pnpm --filter @loom/daemon negative-control` against a real git ref)
  — report its output in the card's worker_report/Code Review, never ship it as code the gate re-runs.
  (Caught on this exact card, second Code Review round, after the first round's own fix had already done
  precisely this.)
