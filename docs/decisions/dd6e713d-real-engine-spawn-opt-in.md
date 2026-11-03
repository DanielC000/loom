# dd6e713d — a real-engine spawn refuses without an opt-in env, structurally

## Why

Twice in two seats a worker launched a real `claude`/`codex` process by accident while running tests by
hand: once via a kickoff glob ("the 4 disallow-*.mjs") that swept in a manual-only real-spawn file
(lesson 296), once via a Code Reviewer's `test/*trigger*.mjs` glob that matched an underscore-prefixed
probe (lesson 297, card 66ff7321 CR round 2). Both kickoffs already said "name every file" — a prose rule
read past twice, per project memory `shipping-a-detector-is-not-someone-reading-it` — so this card adds a
structural guard: a file that can launch a real engine now refuses at its own top unless
`LOOM_ALLOW_REAL_ENGINE=1` is set.

## Mechanism

- `packages/daemon/test/_real-engine-spawn-basenames.mjs` — a pure, side-effect-free data module
  exporting `REAL_ENGINE_SPAWN_BASENAMES`, the single, judgment-curated source of truth for which test
  files can launch a real engine. Membership criterion: a file calls `host.spawn(...)`/`pty.spawn(...)`
  (or an equivalent direct node-pty spawn) against the REAL, un-overridden `PtyHost` — no
  `createSeamHost(...)` fake-pty seam, no local `createPty`/`createCodexPty` override, and no
  `LOOM_CLAUDE_BIN`/`LOOM_CODEX_BIN` fixture-binary substitution. Curated by reading each file, never by a
  name-pattern grep — the investigation for this card found a 32nd genuine engine-spawning file,
  `_smoke-mode-fix-9c03f5a6.mjs`, that neither of the card's own two glob patterns (`_probe-*.mjs`,
  `*real-spawn*.mjs`) names, and conversely found several `*real-spawn*`-named files that spawn a fixture
  binary, a non-engine process (git/npm/turbo/cmd.exe/node), or nothing at all.
- `packages/daemon/test/_real-engine-opt-in.mjs` — at import time, refuses (prints a `WARN SKIP` line and
  `process.exit(0)`) unless `LOOM_ALLOW_REAL_ENGINE === "1"`. Every file in `REAL_ENGINE_SPAWN_BASENAMES`
  imports it as its FIRST import line — ESM evaluates every static import, in the order written, before
  any body statement runs, so being first here means the check runs before any later import's own module
  body could itself cause a side effect, not merely before this file's own later statements. (Round 2:
  this file no longer re-exports `REAL_ENGINE_SPAWN_BASENAMES` — nothing imported it from here; the
  export was dead weight that also invited exactly the self-refusal bug described next.)
- The array is split into its own side-effect-free module specifically because ESM evaluates a module's
  ENTIRE body on import regardless of which named export the caller wants — a guard that imported
  `REAL_ENGINE_SPAWN_BASENAMES` straight from `_real-engine-opt-in.mjs` would trigger that file's own
  `process.exit(0)` and refuse itself. This was a real bug found on this guard's first run, not a
  theoretical concern.
- `packages/daemon/test/real-engine-spawn-opt-in-guard.mjs` — the enforcing guard, in
  `STATIC_GUARD_REPO_PATHS` (`packages/daemon/src/git/worktrees.ts`). Two parts: (A) every basename in
  `REAL_ENGINE_SPAWN_BASENAMES` must have the opt-in import as its literal first import line; (B) a
  reverse sweep, via the TypeScript compiler API (never a bare text/regex search — a naive
  `host\.spawn\(` search matches 253 files in this corpus, 198 of which spawn against a faked `PtyHost`
  and would be false positives), over every OTHER `test/*.mjs` file for a real-engine spawn-call shape
  (including, since Round 2, a direct `host.createPty(...)`/`host.createCodexPty(...)` call); a hit is
  safe only if it carries one of the three AST-verified markers above, or a reasoned entry in the guard's
  own `NON_ENGINE_ALLOWLIST` — itself now checked by a STALE-ENTRY assertion (Round 2) that fails loud if
  any allowlist entry lacks a genuine, unmarked spawn-call hit. See "Round 2" below for the full fix list.

## The codex-real-spawn family is a deliberate, pre-existing exception — unchanged by this card

`CODEX_REAL_SPAWN_BASENAMES` (`test/_codex-real-spawn-lock.mjs`) is discovered as an ordinary hermetic
test set (never excluded by `NOT_HERMETIC` or the underscore convention) and `scripts/test-daemon.mjs`
schedules it ALWAYS-ON, sequentially, on every ordinary gate/CI invocation — each member self-skips only
if the real, installed `codex` CLI is unavailable/unauthenticated on the host. On a host where `codex` IS
installed and authenticated (e.g. the owner's own self-hosting box), this family genuinely spawns a real
`codex` process on every ordinary merge/worker gate today. That is pre-existing, intentional behavior
(cards 14e6cf5f/3791b14e/fc53ea74 — the family's own cross-process lock and cap-scaled wait budget exist
*because* it's expected to run under real concurrency), not something this card was asked to change —
the manager is raising the policy question with the owner separately. This card's `runOne` change
(`scripts/test-daemon.mjs`) supplies `LOOM_ALLOW_REAL_ENGINE=1` to exactly the `CODEX_REAL_SPAWN_SET`
members, and to nothing else, so that pre-existing schedule keeps working unchanged under the new
structural refusal. **Correction (Round 2):** this was originally proved via a claimed "byte-identical
`--list` discovery output before and after the change" — that overstated it. The `runOne` edit itself
touches only the env-building step and leaves `discoverHermeticTests`/`NOT_HERMETIC`/`resolveSelection`
untouched, so it never changes which PRE-EXISTING name gets selected or how. But the card's own tree adds
`real-engine-spawn-opt-in-guard.mjs` as a brand-new, non-underscore-prefixed file — which
`discoverHermeticTests` DOES pick up as one additional hermetic test file (verified: `git show
6cb553ee --diff-filter=A --name-only` lists it as newly added, alongside two underscore-prefixed data
modules that stay excluded) — so the discovered set is `N+1`, not byte-identical, before vs. after this
card's own diff. The accurate claim is narrower: the *selection logic* is unchanged, and the *codex-family
schedule specifically* (what this paragraph is actually about) is unaffected — not that the overall
`--list` output is identical.

Every OTHER member of `REAL_ENGINE_SPAWN_BASENAMES` (the 19 underscore-prefixed manual probes plus the 5
claude-family files in `NOT_HERMETIC`) is never discovered, never selectable via `--only=`/`--only-file=`
(`resolveSelection` refuses a name outside the discovered hermetic set), and so never scheduled by the
gate or CI at all — their only exposure is a direct `node test/<file>.mjs` invocation or an accidental
shell glob, exactly the lesson 296/297 shape. No env injection is needed or supplied for any of them; the
opt-in import alone is their whole defense.

## Round 2 (Code Review of Round 1, commit 6cb553ee)

The guard's core mechanism (the first-import opt-in, SKIP behavior, unchanged gate selection, ~8s cost)
was sound. Nine issues in `real-engine-spawn-opt-in-guard.mjs` itself:

1. `NON_ENGINE_ALLOWLIST` pruned from 20 to 4 entries. 14 were DEAD (no spawn-call hit under this guard's
   own detectors, so a future real spawn added to that file would have been silently exempt) and 2 were
   REDUNDANT (`kickoff-real-spawn`/`give-up-hold-scale-real-spawn` are already `REAL_ENGINE_SPAWN_BASENAMES`
   members, which `findUnlistedEngineSpawnCandidates` excludes before the allowlist is ever consulted). A
   new STALE-ENTRY assertion (`findStaleAllowlistEntries`) now fails loud if any allowlist entry lacks a
   genuine spawn-call hit with no safe marker — RED-proven against a synthetic dead/redundant allowlist.
2. `findSpawnCallHits` now also matches a direct `<expr>.createPty(...)`/`<expr>.createCodexPty(...)`
   call (and the same shape via `super.<name>(...)`) — `pty-codex-spawn-env.mjs:121` calls
   `host.createCodexPty(opts)` directly against an unsubclassed `PtyHost`, which the Round 1 detector
   missed entirely. Measured zero new real-corpus violations after adding this (that file is independently
   covered by its own `LOOM_CODEX_BIN` override).
3. The three safe markers are now checked as real AST shapes, not file-wide text/regex: `createSeamHost(`
   is a `CallExpression` of that identifier; the bin-override marker requires a genuine `=` assignment
   (`BinaryExpression` with `EqualsToken` — never `==`/`===`) to `process.env.LOOM_CLAUDE_BIN`/
   `LOOM_CODEX_BIN` with a non-empty-string RHS; the method-override marker requires a
   `createPty`/`createCodexPty` `MethodDeclaration` whose body does NOT call
   `super.createPty(...)`/`super.createCodexPty(...)` (a super-delegating override still reaches the real
   engine through its heritage). Measured AST-vs-regex divergence on the real corpus: **3 files**, not 0 as
   originally estimated — `ensure-trusted-config-dir-redirect-guard.mjs`, `fixed-tmpdir-literal-guard.mjs`,
   and `pty-subclass-reap-seam-guard.mjs` each textually mention `createSeamHost(`/a bin-override pattern
   inside a comment or a string-literal test fixture, which the old regex matched as "safe" and the AST
   version correctly does not. The divergence is inconsequential to PART B's real verdict: all 3 have ZERO
   genuine spawn-call hits, so the marker question never actually decides anything for them either way —
   but "0 divergence" was the wrong number to report, and this record states the real one.
4. Header blind spots, named explicitly: a bare `spawn(...)`/`execFile("claude", ...)` from
   `node:child_process` reached without going through `PtyHost`; `SessionService`-mediated reach
   (`svc.startNew`/`spawnWorker` driving an unsubclassed `PtyHost` internally); the HTTP-driven
   `NOT_HERMETIC` family, out of scope entirely (guarded instead by `requireHermeticEnv({port:true})`); a
   marker scoped to the wrong harness (a `LOOM_CLAUDE_BIN` override covering a file whose real spawn is
   actually `createCodexPty`, or vice versa); a `createSeamHost(` seam on one host instance while a second,
   genuinely real host is spawned elsewhere in the same file; and a `super` call gated behind only one
   branch of an override (a false positive, never a false negative, for that specific shape).
5. The synthetic fixture strings (the LOOM_CLAUDE_BIN-override text, plus four more added for this
   round's own regression proofs) moved into `packages/daemon/test/_real-engine-spawn-guard-fixtures.mjs`
   — a side-effect-free, underscore-prefixed data module, invisible to
   `ensure-trusted-config-dir-redirect-guard.mjs`'s own real-corpus scan (which skips every
   underscore-prefixed basename). This replaces the original `.join("")` string-concatenation dodge with
   plain, readable literals. Note: moving these out was necessary but not sufficient on its own — three of
   this round's OWN new literal fixture strings (the `==`/`===`/empty-string/comment-only regression
   proofs) initially reintroduced the same false positive by co-locating `LOOM_CLAUDE_BIN`-looking text
   with a `.spawn(` call inside the guard file directly; those moved into the same fixtures module too,
   and one `check()` LABEL string (not code) that happened to literally spell
   `process.env.LOOM_CLAUDE_BIN = x` was reworded.
6. `@decision dd6e713d` anchors added to `_real-engine-opt-in.mjs` and the guard, each stating one
   concrete prohibition inline rather than a "see docs/…" pointer (per this repo's comment-anchor-lint).
   The membership criterion for `REAL_ENGINE_SPAWN_BASENAMES` is now stated ONCE, in the guard's own
   header; `_real-engine-opt-in.mjs`'s header is a pointer to it, not a restatement.
7. The dead re-export of `REAL_ENGINE_SPAWN_BASENAMES` from `_real-engine-opt-in.mjs` is removed — nothing
   imported it from there (the guard always imported from `_real-engine-spawn-basenames.mjs` directly).
8. `findSpawnCallHits`/`findSafeMarker` now accept either raw text or an already-parsed `ts.SourceFile`;
   `findUnlistedEngineSpawnCandidates`/`findStaleAllowlistEntries` each parse a file's text once and pass
   the same `SourceFile` to both detectors, instead of re-parsing per detector call.
9. See the corrected `--list` paragraph above — the Round 1 "byte-identical" claim overstated what was
   actually proved.

## Do not

- Do not derive `REAL_ENGINE_SPAWN_BASENAMES` membership (or the `NON_ENGINE_ALLOWLIST` in
  `real-engine-spawn-opt-in-guard.mjs`) from a name pattern — read each file's own spawn call and binary
  resolution. `_probe-*`/`*real-spawn*` is not a reliable proxy in either direction (see the 32nd-file and
  non-engine-named-file findings above).
- Do not import `REAL_ENGINE_SPAWN_BASENAMES` from `_real-engine-opt-in.mjs` anywhere that must NOT itself
  be subject to the opt-in refusal (e.g. the guard) — import it from the side-effect-free
  `_real-engine-spawn-basenames.mjs` instead.
- Do not widen `real-engine-spawn-opt-in-guard.mjs`'s AST-based spawn-call detection to a broader
  text/regex pattern "to be safe" — its own header names the measured false-positive rate of the naive
  alternative (253 files) and the known blind spots (a renamed import, an indirect call through a stored
  reference, a dynamic property name, a per-harness-scoped marker, a per-branch-gated `super` call, and
  more — see the guard's own header) explicitly; chase a real gap if one appears, don't pre-emptively
  broaden the pattern.
- Do not add a `NON_ENGINE_ALLOWLIST` entry (or leave a stale one in place) without a genuine, unmarked
  spawn-call hit behind it — the guard's own STALE-ENTRY assertion exists to catch exactly that; fix the
  entry (or the file), never silence the assertion.
- Do not inline the guard's own synthetic fixture strings back into the guard file via string
  concatenation or any other dodge of `ensure-trusted-config-dir-redirect-guard.mjs` — add them to
  `_real-engine-spawn-guard-fixtures.mjs` instead (Round 2, item 5).
- Do not change `scripts/test-daemon.mjs`'s discovery/selection logic (`discoverHermeticTests`,
  `NOT_HERMETIC`, `resolveSelection`, `classifyCliArgs`) to accommodate this card — the `runOne` env
  injection is the only touch point, and it must stay that way; the gate's selected file set is
  unchanged by design.
- Do not read the codex-real-spawn family's always-on real spawn as something this card was meant to
  stop — it is a deliberate, owner-relevant policy question raised separately, not a defect this guard
  closes.
