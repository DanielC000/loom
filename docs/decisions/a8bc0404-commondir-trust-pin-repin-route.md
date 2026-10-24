# a8bc0404 — a human re-pin route for a commondir trust pin mismatch

Follow-up from `3a5c5d4a`'s fifth Code Review (`cdf967fc`, S-1, MEASURED), which this card's own body
quotes: once a commondir trust pin exists, nothing can refresh it — a same-path `updateProject` is a no-op
(`from` equals `to` after normalisation), and the boot backfill skips any `repoPath` that already has a
pin. So a legitimate change behind the same literal path (the repo moved and a junction was left at the
old path, or `git init` ran inside a pinned subdir) refused every canonical git call for that
(project, repoKey) forever, fail-closed, with no remedy but a manual DB edit. The refusal also used to
reach the human with the commondir-REDIRECT wording ("remove the planted commondir pointer… do not
retry"), which is wrong for a pin mismatch — it describes an attack, not a stale anchor.

Read `docs/decisions/3a5c5d4a-canonical-git-commondir-trust.md` first, especially its round 5/6 sections
(the durable pin + per-project ownership/handoff design this card builds directly on top of).

## The fix

**(1) `POST /api/projects/:id/commondir-trust-pin/repin`** (`gateway/server.ts`) — a HUMAN-ONLY loopback
REST route, mirroring the existing `/mainline-watermark/reset` route's shape exactly: `{id}` param,
`{repoKey?}` body (defaults `"primary"`), 404 on an unknown project or repoKey. NOT an agent MCP tool on
any router — never registered on `mcp/platform.ts` or `mcp/setup.ts`.

`Db.repinCommondirTrust(projectId, repoKey, repoPath, expectedToplevel)` does the work:
- Reuses the ALREADY-REVIEWED, non-throwing `checkCommondirPinConflicts` for the OWNERSHIP CHECK ITSELF —
  never duplicates round 6's handoff/conflict logic. A path pinned to a DIFFERENT (project, repoKey)
  whose live walk does NOT confirm that owner's recorded toplevel refuses (`kind:"conflict"`, 409) — but
  (round 2, m4 below) with `repinCommondirTrust`'s OWN wording, naming the real owner's project id and
  the repin-specific remedy, never `checkCommondirPinConflicts`' own bind/rebind-away text. The benign
  "different owner, but a live walk confirms the SAME toplevel" case passes the conflict check —
  `pinCommondirTrust` then leaves that owner's real pin untouched and only writes the caller's own index
  entry, identical to existing bind-time semantics.
- A fresh `resolveTrustedToplevel(repoPath)` walk; refuses (`kind:"walk-failed"`, 400) if it fails.
- **Manager amendment A1 (TOCTOU guard).** A bare live-walk re-pin would trust whatever toplevel exists AT
  CALL TIME — including one planted in the window between a human reading a `pinMismatch` refusal (which
  now NAMES the live toplevel it found) and calling this route. `expectedToplevel` (required) must match
  that fresh walk (case-folded on win32, same as the pin comparison); a mismatch refuses
  (`kind:"expected-mismatch"`, 409) naming both values, with NO write and NO durable event (only a
  `console.warn` — this is a safety check catching a race, not a legitimate re-pin attempt, so it is never
  audited as one).
- **Manager amendment A2 (disclosure).** Every OTHER (project, repoKey) index entry already naming this
  literal path is collected via `listOtherCommondirPinIndexHolders` (mirrors `findOtherCommondirPinHolder`'s
  own live-validate-and-clean-stale-rows shape, but returns every match instead of the first) and returned
  as `alsoAffects` in the 200 body AND the durable event — a re-pin changes the trust anchor those entries'
  own future lookups compare against too, since they all share the ONE `commondir-trust-pin:<literalPath>`
  row.
- On a GENUINE change (`changed:true` — round 2, m5 below): overwrites the pin via the existing
  `pinCommondirTrust(..., "human-repin", <this walk's own toplevel>)` (widens `CommondirTrustPin["source"]`),
  and files its OWN `commondir_trust_pinned` event (`detail.event:"human-repin"`, `{projectId, repoKey,
  repoPath, oldToplevel, newToplevel, alsoAffects}`) — distinct from `pinCommondirTrust`'s own silent
  write, which files nothing on an ordinary bind/rebind. A benign NO-OP (the live walk already matches the
  existing pin) returns `{ok:true, changed:false, ...}` instead — no write, no event (see m5 below).

No `this.db.transaction()` wrap: this method never touches `insertProject`/`updateProject`'s own
INSERT/UPDATE statement, so it has no atomicity need beyond each individual SQL statement's own — same
posture as `unpinCommondirTrustIfOwned`/`backfillCommondirTrustPins`'s existing event-filing, both of
which already fire `appendEvent` outside of any surrounding transaction.

**(2) Distinct refusal wording for a pin MISMATCH vs. a planted commondir.** `checkCommondirTrust`'s
top-of-function pin consultation gains a FOURTH `kind`, `"pinMismatch"` (alongside the pre-existing
`"redirect"`/`"boundRepoIsWorktree"`/`"unpinned"`), thrown as the new `CanonicalGitPinMismatchRefusal`.
**Round 2 correction (Code Review `7344e137`, C1):** the first attempt classified ANY disagreement
between the pin and a live check as `pinMismatch` — including a FAILED walk (`!live.ok`), which is
exactly the shape every attack takes (a planted `commondir` file, a `.git` FILE, a `.git` symlink —
`resolveTrustedToplevel`'s own refusal reasons). Since bind + the boot backfill pin nearly every project,
that meant the common attack case got the SOFT "maybe re-pin" wording instead of the ALARM. Fixed: the
pin branch now splits on `live.ok` FIRST — a failed walk stays `kind:"redirect"` (the pre-existing
`CanonicalGitCommondirRefusal` alarm wording, unchanged); only a VALID walk resolving to a genuinely
DIFFERENT toplevel is `"pinMismatch"`. See the round-2 wording ruling below for why the `pinMismatch` text
itself still never presents re-pinning as the default remedy.

**Manager amendment A3 (inheritance, not a sibling).** `CanonicalGitPinMismatchRefusal extends
CanonicalGitCommondirRefusal` (not the bare `CanonicalGitRefusal`) — deliberately, so every EXISTING
`instanceof CanonicalGitCommondirRefusal` / `describeGitFailure().commondirRedirect` consumer keeps
matching it with NO code change, and a pin mismatch — if anything the MOST suspicious of the four refusal
shapes, since it's an established trust anchor that no longer matches — stays classified as "could be a
redirect" by default, unlike `CanonicalGitBoundWorktreeRefusal`/`CanonicalGitUnpinnedRefusal`, which are
explicitly non-attack shapes and deliberately NOT subclasses of it. `describeGitFailure` gained a narrower
`pinMismatch` field (also true for it, via inheritance, is `commondirRedirect`) and `canonicalFailureMessage`
gained a branch for it — checked BEFORE the generic `commondirRedirect` branch, since the subclass relation
means the generic branch would otherwise win first — naming the pinned vs. live toplevel (already in the
enriched `checkCommondirTrust` reason text) and pointing at the repin route (`POST
/api/projects/:id/commondir-trust-pin/repin`, passing the named live toplevel as `expectedToplevel`) as the
remedy if the change was intended, else escalate to the Platform Lead exactly like the sibling branches.

### A3's per-site sweep — what changes at each consumer of the redirect kind / class

Grepped every consumer of `kind === "redirect"` / `.redirect` / `CanonicalGitCommondirRefusal` in
`packages/daemon/src`. The OTHER `kind === "redirect"` hits (`connections/oauth.ts`, `connections/
sonarqube.ts`, `orchestration/alert-webhook.ts`, `companion/telegram.ts`, `orchestration/usage-status.ts`,
`sessions/service.ts:2405`) are an UNRELATED HTTP-redirect-guard "kind" enum from a different mechanism
entirely (URL-fetch SSRF guarding) — confirmed irrelevant, not touched.

Real consumers, and the decision at each:

1. **`git/bounded.ts` — `describeGitFailure`/`canonicalFailureMessage`/`canonicalRaw`'s throw-mapping.**
   Edited (this card). `pinMismatch` gets its own field + its own `canonicalFailureMessage` branch, checked
   first; `commondirRedirect` stays true for it too (inherited), so a caller that only ever checked that
   coarser field keeps behaving exactly as before.
2. **`git/bounded.ts` — `probeGitIdentResolvable`** (`resolveGitIdentityFallbackArgs`'s identity-fallback
   probe): `if (e instanceof CanonicalGitRefusal) throw e;` — a generic base-class check, already covers
   `CanonicalGitPinMismatchRefusal` via the inheritance chain. **Decision: UNCHANGED, no site-specific
   handling added.** A pin-mismatch during an identity-fallback decision re-throws and aborts the whole
   fallback, exactly like a redirect/unpinned/boundRepoIsWorktree refusal already does there — correct
   behaviour, not a gap.
3. **`git/worktrees.ts`** — every `.text`-only or full-pass-through site: `:8074`, `:9291` (both
   `return { ok: false, reason: `identity-fallback probe refused: ${describeGitFailure(e).text}` }` — bare
   `.text` extraction, no kind-specific branching at all), `:8122`/`:8127` and `:8160`/`:8183` (the
   owed-landing fast-forward path's own `describeGitFailure(e)` → `canonicalFailureMessage(d, ...)`, full
   result passed through), and `:9106` (`squashRefusalDetail = e instanceof CanonicalGitRefusal ?
   describeGitFailure(e) : undefined`, then `canonicalFailureMessage(squashRefusalDetail,
   squashRefusalDetail.text)`). **Decision: zero code change needed at any of these** — `pinMismatch`
   flows through automatically with its improved wording wherever the full result is passed, and a bare
   `.text` site never branches on kind at all; both are strict improvements with no behaviour-divergence
   risk (same `ok:false` refusal shape as before, just better text where kind-specific wording applies).
4. **`git/worktrees.ts` `mergeMainIntoWorktree`** (lines ~8222-8248, ~8343 pre-round-2): the ONE site that
   manually reconstructed a `describeGitFailure`-shaped literal instead of passing the result through.
   **Round 1 decision: edited** (added a 4th local, `mergePinMismatch`, captured alongside the other
   three, included in the literal). **Round 2 (Code Review m6): refactored further** — replaced ALL FOUR
   narrow per-field locals (`mergeCommondirRedirect`/`mergeBoundRepoIsWorktree`/`mergeUnpinned`/
   `mergePinMismatch`) with ONE `mergeDescribe: ReturnType<typeof describeGitFailure> | undefined`,
   capturing the WHOLE result once and passing it straight into `canonicalFailureMessage(mergeDescribe!,
   mergeErr)` at the one render site — the exact hand-reconstruction pattern that made `mergePinMismatch`
   need manual wiring in round 1 is now gone; any FUTURE `describeGitFailure` field reaches this site for
   free. `mergeErr`/`mergeRefused`/`mergeThrew`/`mergeErrObj` are untouched — each is used independently
   at multiple OTHER sites in this function (not just the one reconstruction site), so collapsing them
   into the same object would have been a much larger, riskier refactor than this card's scope calls for.
5. **`git/batch-merge.ts`** — every `.text`-only or full-pass-through site: `:484` (bare `.text`
   extraction, identity-fallback probe, same shape as worktrees.ts `:8074`/`:9291`), `:522`/`:533`/`:547`/
   `:551` (the batch rollback helper's own `describeGitFailure(e).text` extractions, folded into
   `rollbackIssue` — never branches on kind), and `:598-600`/`:670-672`/`:1150-1152` (cherry-pick-commit/
   fast-forward sites that pass the FULL `describeGitFailure()` result into `canonicalFailureMessage`).
   **Decision: zero code change needed at any of these** — same reasoning as #3.
6. **`git/mainline-watch.ts`**: grepped for `CanonicalGit`/`describeGitFailure`/`canonicalFailureMessage`/
   `commondir` — zero matches. This module has a blanket fail-open catch-any-error posture
   (`docs/decisions/4fa36502-mainline-move-tripwire.md`) with no type-specific branching at all. **Decision:
   UNCHANGED** — a `pinMismatch` refusal reaching this path (the project's own bound repo, read-only) is
   absorbed exactly like every other git error today, including the pre-existing redirect/boundRepoIsWorktree
   cases (round 3 S3 of `3a5c5d4a` already established this for `CanonicalGitBoundWorktreeRefusal`): "check
   skipped (fail-open)", no special handling, no new gap.
7. **Quarantine raise paths** (`enterMergeQuarantine`, `RepoQuarantinedError`): grepped every
   `enterMergeQuarantine`/`RepoQuarantinedError` call site reachable from a `checkCommondirTrust` refusal —
   quarantine is raised ONLY on `treeDeathUnconfirmed(e)` (an unconfirmed-kill condition on a REAL spawned
   process) or `e instanceof RepoQuarantinedError` (an ALREADY-quarantined repo). Neither check is, or was,
   keyed on any `CanonicalGit*Refusal` class. **Decision: UNCHANGED, structurally** — `checkCommondirTrust`
   runs BEFORE any git process is spawned (`canonicalRaw`'s very first step), so there is no process to have
   an unconfirmed kill on; a commondir refusal of any kind — old or new — can never raise a quarantine, by
   construction, not by a per-type check that might have missed this one.
8. **Mainline alerting** (`mainline_moved_outside_loom` events): no separate site exists beyond #6 above —
   `mainline-watch.ts`'s fail-open catch is the only interaction, already covered.
9. **Durable events keyed on a refusal type**: grepped for an `appendEvent` call gated on
   `instanceof CanonicalGit*Refusal` anywhere in the daemon — none exists. A refusal only ever becomes a
   `reason` string via `canonicalFailureMessage`, which flows into a `worker_report`/merge-confirm response,
   never a type-discriminated durable event (other than this card's OWN new `commondir_trust_pinned`
   `"human-repin"` event, which is about the REPIN action, not about a refusal being hit).

## (4) N-1 fold-in — `prepareCanonicalEnv`'s ceiling now consults the pin

`prepareCanonicalEnv`'s `GIT_CEILING_DIRECTORIES` computation, for a subdir-bound repo (no own `.git`), used
to call `resolveTrustedToplevel(repoPath)` directly — a bare, unverified walk, the same "walk as its own
trust source" mistake round 5 of `3a5c5d4a` eliminated everywhere else (`defaultTrustedMainRoot`,
`checkCommondirTrust`'s own pin consultation). Fixed to consult the pin first via the existing
`liveToplevelMatchesPin` helper, using `pin.toplevel` on a live match; falls back to the bare walk when
there's NO pin at all, OR when one exists but doesn't match live (m7 — the round-1 version of this
sentence wrongly said "only when no pin exists", corrected in the code comment and here together) — inert
either way, since `checkCommondirTrust` already refuses that call before any git process runs regardless
of what this ceiling computed. Defense-in-depth/consistency fix, not a newly discovered live exploit.

## Settings UI button — explicitly skipped

Item (3) of the card is marked optional. Skipped: same posture as `/mainline-watermark/reset`, which also
has no UI button — a human can already drive this via the documented POST route. Not built here; a
follow-up card if wanted.

## Card 87b1c8a1 — no dependency, either direction

`repinCommondirTrust` calls the PUBLIC, non-throwing `checkCommondirPinConflicts` directly, never the
private throwing `assertNoCommondirPinConflicts` twin that `87b1c8a1` plans to wrap in a typed
`CommondirPinConflictError` — no coupling to that type change. Its own `appendEvent` call sits outside any
`insertProject`/`updateProject` transaction (same as `unpinCommondirTrustIfOwned`'s/`backfillCommondirTrustPins`'s
existing event-filing, neither of which `87b1c8a1` touches) — `87b1c8a1`'s deferred-event-until-commit fix
targets a different code path.

## Round 2 (Code Review `7344e137`) — one Critical (C1, above), two Majors, five minors

**M1 (the live toplevel was still truncatable).** `describeGitFailure().text` caps at 400 chars; the
round-1 raw reason led with `repoPath`/pin metadata/timestamp/source BEFORE the live toplevel, so an
ordinary 80-100-char path could push the live value itself past the cap. Fixed two ways, together:
(1) `CanonicalGitPinMismatchRefusal` now carries `pinnedToplevel`/`liveToplevel` as STRUCTURED,
never-truncated fields (constructor params, threaded through `checkCommondirTrust`'s own `pinMismatch`
return variant → `canonicalRaw`'s throw-mapping → `describeGitFailure`'s result); (2) the RAW reason
string itself (and `canonicalFailureMessage`'s rendering of it) now LEADS with the live toplevel —
`"canonicalGit: refusing — live toplevel is now "<live>" (was pinned to "<pinned>" at ..."` — so even the
400-char-capped `.text` field carries the live value intact on an ordinary path length, not just the
structured fields (a belt-and-suspenders pair, not a single point of failure). Test: a ~100+ char
synthetic path (`canonical-git-commondir-refusal.mjs` (12e-2)) proves the full live toplevel survives
`describeGitFailure().text` intact.

**M2 (A1's own TOCTOU invariant leaked through a SECOND walk).** `repinCommondirTrust` walks once (for
its own `expectedToplevel` check), then called `pinCommondirTrust`, which walked AGAIN internally. If
that second walk failed (a genuine TOCTOU race — the filesystem changed between the two synchronous
calls), `pinCommondirTrust` silently no-op'd (clearing the index, no pin write) while
`repinCommondirTrust` — having already computed `oldToplevel`/`alsoAffects` before calling it — still
returned `ok:true` and filed the event, reporting success for a write that never happened. Fixed:
`pinCommondirTrust` gained an optional 5th param, `resolvedToplevel` — when supplied, used VERBATIM,
never re-walked; `repinCommondirTrust` now passes its OWN walk's result straight through
(`pinCommondirTrust(projectId, repoKey, repoPath, "human-repin", walk.toplevel)`). Every OTHER existing
caller (bind/rebind/backfill) omits the param and keeps the original single-walk-per-call behaviour
unchanged. Proven directly (not simulated as a race, which synchronous code structurally cannot
interleave): `commondir-trust-pin-repin-route.mjs`'s dedicated M2 section calls `db.pinCommondirTrust(...)`
with a `resolvedToplevel` NO real walk of the target repo could ever produce, and confirms the write
reflects that EXACT value — proving the function honors the passed value rather than re-deriving it —
plus a control confirming the omitted-param fallback still walks correctly for every other caller.

**m4 (wrong remedy for a non-owner).** A non-owner's repin attempt surfaced
`checkCommondirPinConflicts`' own bind/rebind wording ("delete or rebind project X away from this path")
— the wrong remedy for a REPIN attempt, which isn't trying to bind anything. Fixed: `repinCommondirTrust`
now builds its OWN error on a conflict, naming the real owner's project id and the actual remedy (ask that
owner, or call this SAME route with `projectId=<owner>`) — `checkCommondirPinConflicts`' generic wording
is only a defensive fallback now, unreachable in practice since a conflict there always implies an
existing different-owner pin exists to describe.

**m5 (a benign no-op was audited as a real repin).** When the live walk still matches the EXISTING pin
(nothing is actually stale — a human re-confirming trust that was never broken), `repinCommondirTrust`
used to write anyway and file a `"human-repin"` event with `oldToplevel === newToplevel`. Fixed: detected
BEFORE the write (`oldToplevel !== null && caseFold(oldToplevel) === caseFold(walk.toplevel)`) and short-
circuited to `{ok:true, changed:false, oldToplevel, newToplevel, alsoAffects}` — no write, no event. A
genuine change still returns `changed:true` and behaves exactly as round 1 did.

**m6 (optional — done, see A3 sweep item 4 above).** `mergeMainIntoWorktree` now passes the WHOLE
`describeGitFailure()` result through a single `mergeDescribe` local instead of four hand-copied
booleans — closing the exact pattern that made `mergePinMismatch` need manual wiring in round 1.

**m7 (the N-1 comment was inaccurate).** The N-1 fold-in's own comment said the bare-walk fallback runs
"only with no pin" — false: it ALSO runs when a pin exists but doesn't match live (the `pin &&
liveToplevelMatchesPin(...)` guard is false in BOTH cases). Corrected in place; the behaviour was always
correct, only the comment was wrong.

**m8 (the A3 table was incomplete).** The "A3's per-site sweep" section above now explicitly enumerates
every site the reviewer found by reading the diff (`worktrees.ts` `:8074`/`:8122`/`:8160`/`:9291`;
`batch-merge.ts` `:484`/`:522`/`:533`/`:547`/`:551`), not just the subset round 1 had already found by its
own independent grep — all confirmed `.text`-only or full-pass-through, zero code change at any of them.

## Do not

- Do not duplicate round 6's ownership/conflict logic in `repinCommondirTrust` — always route through the
  PUBLIC `checkCommondirPinConflicts`; a second, hand-rolled conflict check is exactly how the two would
  silently diverge on what counts as a conflict.
- Do not skip the `expectedToplevel` check, or make it optional — it is the ONLY thing closing the TOCTOU
  gap between a human reading a refusal's live toplevel and calling this route; a bare live-walk re-pin
  re-opens it completely.
- Do not audit an `expected-mismatch` refusal as a `commondir_trust_pinned` event — it is a safety check
  that caught a race, not a re-pin that happened; log it (`console.warn`) and refuse, nothing durable.
- Do not audit a benign NO-OP repin (m5) as a real one either — `changed:false`, no write, no event; only
  a GENUINE change (`changed:true`) gets the write + the event.
- Do not read `commondirRedirect:true` as proof a refusal is the attack-shaped planted-commondir case —
  since round A3, it is ALSO true for a `pinMismatch`. Check `pinMismatch` first wherever both are available.
- Do not classify ANY pin disagreement as `pinMismatch` (C1) — a FAILED walk (`!live.ok`) is the attack
  shape and must stay `kind:"redirect"` with the alarm wording; only a VALID walk at a genuinely different
  toplevel is `pinMismatch`. Checking `live.ok` first is load-bearing, not an optimization.
- Do not let `pinCommondirTrust` re-walk when a caller already has a resolved value in hand (M2) — a
  SECOND walk can diverge from the caller's own FIRST walk under a genuine TOCTOU race; thread the
  already-resolved value through via `resolvedToplevel` instead.
- Do not reuse `checkCommondirPinConflicts`' own error text verbatim in `repinCommondirTrust` (m4) — it
  names the bind/rebind remedy, which is wrong for a repin attempt; name the real owner's project id and
  the repin-specific remedy instead.
- Do not add a new `CanonicalGit*Refusal` subclass as a SIBLING of `CanonicalGitCommondirRefusal` without
  re-running this card's own per-site sweep (the "A3's per-site sweep" section above) — the sweep is what
  proved every existing consumer stays correct; a new, differently-classified subclass needs the same
  review, not an assumption that the existing sweep still covers it.
- Do not add this route, or anything resembling it, to `mcp/platform.ts` or `mcp/setup.ts` — same trust
  class as the git/vault writers already documented as human-only-REST in `CLAUDE.md`.
