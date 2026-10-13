# 3493d0b6 — daemon test-suite audit (round 1: inventory; round 2: cost + value lenses; round 3: execution)

Card `3493d0b6`. The owner suspected many `packages/daemon/test/*.mjs` files are redundant, useless, or
test unimportant things, and asked for an audit before any removal. **Round 1** inventoried and classified
every file by redundancy alone. **Round 2** ran a sharper pass using two new lenses the owner specified —
a COST lens against real, current per-file gate timing, and a VALUE lens that looks at what a file
actually asserts rather than what incident it cites. **Round 3** (this update) executed the authorized
findings: the round-1 merge, the one clean VALUE-lens deletion, and the COST-lens speedups (3 of 5 landed
with measured before/after timing and RED-proofs; 1 reverted after a RED-proof showed it unsafe; 1
skipped with no safe fix identified).

## Headline result

**Round 1 did not confirm the "many redundant tests" premise, and round 2's sharper VALUE lens still
mostly doesn't — but it is not a clean sweep.** Of 1570 real test files, 156 are protected (curated
guard/scanner lists, CLAUDE.md triggers, or the card's active-work carve-out) and the remaining 1414 were
reviewed. Round 1 (simple redundancy): **1413 KEEP, 1 MERGE**. Round 2's VALUE lens (does the file assert
anything that doesn't need a test — prose-only, trivial-constant, dead-feature, or byte-for-byte
duplicate, judged at the `check()` level, not the header level): **1 clean REMOVE-CANDIDATE**
(`worker-skill-dev-server-reference-split.mjs`) **and 1 candidate considered and REJECTED**
(`gate-verdict-field-classification-exhaustive.mjs` — looks like a compiler-redundant constant/shape check
on the surface, but is actually a falsification-proven cross-project redaction chokepoint guard with a
real incident behind it). Round 2's COST lens found **5 SPEEDUP-CANDIDATEs** out of the 30 non-protected
files in the real top 40 slowest, estimated at ~35-55s combined — the other 25 are JUSTIFIED.

**Round 3 executed all of this, with real before/after measurement and RED-proofs, and the result was
smaller and more mixed than round 2's estimate.** The merge and the one deletion landed cleanly. Of the 5
speedups: 2 landed with a clean, measured, consistent wall-clock win (~15s and ~5.6s), 1 landed
correctness-neutral with no measurable win (within host noise), 1 was attempted, built, and then
**reverted** after its own mandated RED-proof showed the rewritten mechanism did NOT catch the real bug it
exists to catch, and 1 was skipped outright with no safe fix identified. **Total measured, verified time
saved: ~20.6 seconds** — real, but well short of the ~35-55s estimate, because the two largest estimated
contributors turned out to be the two that couldn't be safely fixed within this round's scope.

So: this corpus is still overwhelmingly NOT bloated with redundant tests, even under a sharper bar, and the
genuine waste that round 2 found was smaller in practice than estimated once actually executed and
verified — round 1's "cites a distinct incident" lens was too generous, but round 2's own COST-lens
estimates, before being tested against real production behavior, were themselves optimistic for the two
riskiest cases.

What *is* well-evidenced, and is probably the better lever for the owner's actual complaint (the gate's
`test:daemon` step taking ~52 minutes): **the test directory has grown ~2.26x in file count in the last
~10 weeks**, independent of any single slow or duplicated file. See "Suite growth" below.

## Methodology

1. Inventoried `packages/daemon/test/*.mjs` — 1621 files, non-recursive (this matches the harness's own
   discovery scope: `test-daemon.mjs`'s `EXCLUDED_DIR_NAMES` = `{"fixtures","census"}` skips those two
   subdirectories' 36 additional `.mjs` files entirely, so they are out of scope for the harness and for
   this audit).
2. Split off 51 underscore-prefixed files (`_guard.mjs`, `_wait.mjs`, `_probe-*.mjs`, etc.) — these are
   shared helpers/fixtures, excluded from test discovery by `isUnderscoreExcluded()`
   (`packages/daemon/scripts/test-daemon.mjs:485`) and never run as standalone tests. Not classified
   KEEP/MERGE/REMOVE (that taxonomy doesn't apply to a helper module); see "Helper modules" below for the
   one thing worth flagging about them.
3. Of the remaining 1570 real test files, marked 156 as **protected** per the card's rule 4 and excluded
   them from candidacy without further review (listed in full below):
   - 115 files named in `STATIC_GUARD_REPO_PATHS` / `ASSET_READING_TEST_REPO_PATHS` /
     `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` / `CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS`
     (`packages/daemon/src/git/worktrees.ts`).
   - ~24 additional files named in `CLAUDE.md`'s own trigger bullets (the surface-drift list, the
     response-key-set guards, the entity-projection chokepoint guards, the content-bearing-log-line gate
     and its named neighbours, the canonical-git tests) that aren't already covered by the four lists
     above.
   - 32 `merge-quarantine-*.mjs` files and 5 files with `index-lock` in the name — named by the card as
     "under active work right now" (the five most recent commits on this branch, at the time this audit
     started, are all narrow quarantine-token/index-lock fixes).
   (Some files appear in more than one source above; 156 is the de-duplicated total.)
4. Grouped the remaining 1414 **open** files into 8 clusters by filename-prefix family and dispatched a
   parallel review of each (general-purpose sub-agents, read-only: header/digest extraction via `head`/
   `grep` first, full read only for files that looked like genuine candidates). Each review was told the
   corpus's "one file per cited incident" convention explicitly, told that narrow scope alone is not
   evidence of redundancy, and told to produce only **evidenced** MERGE/REMOVE-CANDIDATE findings — name
   the overlapping file + the specific overlapping assertion, or cite the src proving a feature is dead.
   | cluster | scope | files |
   |---|---|---|
   | C1 | `merge-*` / `worktree-*` / `worktrees.mjs` / `batch-*` (git/merge orchestration) | 166 |
   | C2 | `companion-*` (chat/companion integration) | 105 |
   | C3 | `pty-*` (terminal host, message drain/give-up/paste) | 98 |
   | C4 | `worker-*` / `task-*` / `tasks-*` (worker lifecycle, board/task tooling) | 134 |
   | C5 | `codex-*` / `recycle-*` (codex harness parity, worker/manager recycle) | 77 |
   | C6 | `platform-*` / `vault-*` / `gate-*` / `project-*` / `skills-*` | 146 |
   | C7a | long-tail alphabetical slice A (≈90 smaller/singleton-named subsystems) | 344 |
   | C7b | long-tail alphabetical slice B (the rest of the long tail) | 344 |
   | **total** | | **1414** |
5. For a strong automated cross-check (not just filename similarity), extracted the first cited
   `Card <8hex>` id from every file's header and flagged every card id cited by ≥3 distinct files (42 such
   card ids, covering 928 of the 1570 real test files that cite a card id at all) as a specific lead for
   the relevant cluster to check. Most of these turned out to be either (a) already-protected files (e.g.
   the `36afbbdd` cluster of 14 files is entirely inside the curated guard/scanner lists), or (b) a shared
   epic/card whose files each cover a different sub-scenario, or (c) a shared *boilerplate* citation (e.g.
   a card about deleting a locally-copied `waitUntil()` helper gets cited in every file's header as an
   infra note, unrelated to what the file actually tests) rather than a shared test subject.
6. Checked EOL on the new file (`CR == LF` byte count) before committing, per this repo's own
   `working-tree-eol-guard.mjs` convention.

No test was executed, `run_gate` was never called, no process was killed by name/port, and `~/.loom` was
never touched — per the card's explicit constraints. The one piece of "cheaply available" timing data this
produced is a *stale, partial* one (see below), not a live measurement.

### Round 2 methodology (COST + VALUE lenses)

7. **Executed the round-1 MERGE finding**: parameterized `skills-codescape-unbundle-retire.mjs` over both
   skill names, deleted `skills-research-unbundle-retire.mjs`, confirmed no reference to the deleted
   filename existed anywhere (`worktrees.ts`'s curated lists, `CLAUDE.md`, any decision record — only this
   investigation doc and immutable historical timing-snapshot rows named it), ran the merged file directly
   (26/26 PASS), ran `pnpm --filter @loom/daemon guards` (30/30 guards pass), and committed.
8. **COST lens**: with the owner's explicit, scoped authorization, read `~/.loom/gate-timing/
   daemon-per-file-timing.ndjson` (the daemon's own live per-file timing telemetry — read-only, by absolute
   path; never written to, copied into the repo, or into any other path under `~/.loom`; the database was
   never opened). That file holds 18,551 lines covering every gate run from 2026-08-01 through today
   (2026-10-13) — current, not the ~10-week-stale committed snapshot round 1 used. Computed, per file name,
   the median of its last-up-to-10 durations restricted to "full-suite-ish" runs (`testCount >= 500`, to
   avoid comparing a small targeted run's concurrency/contention shape against a full one), took the top 40
   by that figure, and cross-referenced each against the protected/already-known-expensive lists: 10 of the
   40 are already protected (rule 4) or already named in `ISOLATED_REAL_SPAWN_BASENAMES`
   (`scripts/test-daemon.mjs`) — a hand-curated set of real-git/real-spawn tests deliberately run in their
   own isolated, serialized phase specifically *because* they're expensive, i.e. already judged and handled.
   The remaining 30 were split across 2 parallel reviewers, each reading every assigned file IN FULL (not
   headers) and judging cost against four criteria the owner specified: a cheaper equivalent fixture, a
   shortenable sleep/poll, redundant in-file scenarios, or the same invariant already proven by a faster
   file. I personally spot-verified the two highest-confidence findings (the `worker-skill-dev-server-
   reference-split.mjs` VALUE finding below, and the `merge-gate-interval-ordering.mjs` 8-second hidden-sleep
   COST finding — confirmed the mechanism by reading the code and counting call sites myself) before
   trusting the rest at the reviewers' stated confidence.
9. **VALUE lens**: re-dispatched the SAME 8 clusters from round 1 (the file lists were unchanged) with a
   deliberately different, sharper question: not "does this cite a distinct incident" but "what does this
   file ACTUALLY assert, at the `check()`/`assert()` level" — against four narrow tests the owner specified
   (prose/comment-only assertions with no behavioral check; a whole-file trivial getter/constant/type-shape
   check the compiler already enforces; a feature/flag verified dead in `src/`; a byte-for-byte sibling
   duplicate). Each reviewer was told explicitly that failing all four tests is the expected, fine outcome
   for most files, and to flag only a concrete, citable match — not narrow scope or "looks like a lot of
   tests for one feature." Protected files were out of scope again, per rule 4. I personally verified both
   of the two candidates that came back (one confirmed, one rejected — see below) by reading the full file
   myself rather than trusting the reviewer's characterization.

## Suite growth (why the gate is probably slow, independent of redundancy)

- At commit `5bf4e138` (2026-08-05 23:37 — the commit the three committed per-file timing snapshots under
  `docs/investigations/*/data/*.ndjson` were captured around), `packages/daemon/test/` held **722** total
  `.mjs` files (26 helpers, 696 real test files).
- Today (this branch's HEAD) it holds **1621** total `.mjs` files (51 helpers, 1570 real test files).
- That is **+899 files, a ~2.26x increase, in ~69 days** — measured via
  `git ls-tree <sha> packages/daemon/test/ | grep -c '\.mjs$'` at both points, not estimated.
- A suite that's 2.26x the file count it was 10 weeks ago will take substantially longer to run even if
  every individual file is exactly as fast as before and nothing is redundant. This round's finding (almost
  no redundancy) is consistent with that: the time cost looks like it's coming from genuine, accumulating,
  non-overlapping coverage, not from duplication.

## Per-file timing (round 1) — cheaply available, but stale and partial

This section is round 1's timing investigation, done under round 1's "never touch `~/.loom`" constraint —
**superseded for currency by the "Round 2 — COST lens" section below**, which reads the live file under a
scoped exception the owner granted for round 2. Kept here for the historical comparison it enables (stale
vs. current) and because it's what established that a current read was worth asking for.

`scripts/test-daemon.mjs` writes **live** per-file timing to `~/.loom/gate-timing/daemon-per-file-timing.ndjson`
on every real gate run. Three **committed** historical snapshots exist under `docs/investigations/*/data/*.ndjson`
(`6c1aadf7-daemon-suite-timing`, `a591a654-gate-timing-attribution`, `90678ee9-gate-inflation-membership`),
all captured 2026-08-01 through 2026-08-05 — i.e. from *before* most of the 899 files added since. Combined,
they carry timing for 666 distinct file names (of today's 1570 real test files — **42% coverage, and
~10-week-stale**). Treat every number below as a historical signal, not a current measurement.

Top 10 slowest by median duration in that stale combined snapshot:

| file | median | n | max |
|---|---|---|---|
| `merge-gate-reuse` | 69.6s | 27 | 125.4s |
| `merge-repo-mutex` | 55.9s | 27 | 229.9s |
| `kickoff-real-spawn` | 48.6s | 27 | 120.1s |
| `gate-timeout-circuit-breaker` | 41.6s | 27 | 70.8s |
| `codescape-health-probe` | 41.1s | 27 | 44.2s |
| `gate-status` | 38.8s | 27 | 51.2s |
| `merge-rest-route-tracked` | 33.1s | 17 | 42.6s |
| `merge-confirm-completion-nudge` | 30.3s | 27 | 108.4s |
| `worker-kickoff-guarantee` | 28.5s | 27 | 32.3s |
| `merge-spawn-tracked` | 26.0s | 27 | 42.7s |

**Important: do not read this table as a removal-candidate list.** `kickoff-real-spawn` is already
protected (on `ASSET_READING_TEST_REPO_PATHS`). `merge-gate-reuse`, `gate-status`,
`merge-confirm-completion-nudge`, `merge-spawn-tracked`, `merge-repo-mutex`, and `merge-gate-inert-diff`
are literally named in `ISOLATED_REAL_SPAWN_BASENAMES` (`scripts/test-daemon.mjs:1090`) — a hand-curated
(read-every-file, not name-pattern-derived — see `docs/decisions/0f0816e2-*.md`) set of real-git/real-spawn
integration tests that are *deliberately* run in their own isolated, serialized phase specifically because
they're expensive and would skew concurrent-pool timing for every other file if mixed in. They are already
recognized as expensive and already specially handled; expensive is not the same claim as redundant, and
C1's review (below) found no overlap among them.

## Protected files (156) — excluded from candidacy this round per the card's own rule 4

Not re-examined for redundancy regardless of appearance, per explicit instruction. Listed by source:

- **`STATIC_GUARD_REPO_PATHS`** (corpus-wide source-text/behavioral guards that must run on every reduced
  gate regardless of diff shape): `clock-path-regression-guard.mjs`, `fixed-wait-negative-guard.mjs`,
  `onexit-discard-guard.mjs`, `codescape-privacy-guard.mjs`, `fixed-wait-witness-guard.mjs`,
  `real-home-scope-guard.mjs`, `harness-adapter-claude-literal-guard.mjs`,
  `remote-trust-single-predicate-guard.mjs`, `working-tree-eol-guard.mjs`,
  `deploy-staleness-fixture-guard.mjs`, `human-only-surface-leak-guard.mjs`, `exit-code-verdict-guard.mjs`,
  `failing-test-tier-pairing-guard.mjs`, `inert-exact-path-corpus-guard.mjs`, `inert-prefix-repo-scan.mjs`,
  `pty-agnostic-methods-findanylive-guard.mjs`, `profile-field-consumer-guard.mjs`,
  `codex-real-spawn-lock-membership-guard.mjs`, `waituntil-message-regex-guard.mjs`,
  `createworktree-loom-home-guard.mjs`, `pty-subclass-reap-seam-guard.mjs`,
  `human-authorized-call-site-allowlist-guard.mjs`, `explicit-role-grant-carryover-allowlist-guard.mjs`,
  `loom-home-write-deny-registry-guard.mjs`, `hermetic-port-listen-guard.mjs`,
  `fixed-tmpdir-literal-guard.mjs`, `first-run-suppress-guard.mjs`, `merge-quarantine-loom-home-guard.mjs`,
  `no-src-testonly-import-guard.mjs`, `ensure-trusted-config-dir-redirect-guard.mjs`.
- **`ASSET_READING_TEST_REPO_PATHS`** (real `packages/daemon/assets/**` content readers): `codescape-prompt-block.mjs`,
  `decision-records.mjs`, `dev-server.mjs`, `ensure-obsidian.mjs`, `kickoff-real-spawn.mjs`,
  `manager-context-block.mjs`, `merge-orphaned-to-main.mjs`, `platform-dev-flag.mjs`, `platform-home.mjs`,
  `redirect-discoverability.mjs`, `role-surface-tools-named-in-doctrine.mjs`, `serve-static.mjs`,
  `serve-static-parity-guard.mjs`, `skills-codescape-reconcile.mjs`, `skills-conditional.mjs`,
  `skills-seed-asset-override-default.mjs`, `skills-store-durability.mjs`, `spawn-command-line-preflight.mjs`,
  `vault-lint.mjs`.
- **`CHANGED_TS_TEXT_SCANNER_REPO_PATHS`** (raw source/dist TEXT scanners, comment-sensitive):
  `agent-runs-keys.mjs`, `event-trigger-mcp-absence.mjs`, `gateway-token.mjs`, `loopback-secret.mjs`,
  `update-endpoint.mjs`, `shutdown-snapshot.mjs`, `periodic-snapshot.mjs`, `git-log-locale-pin.mjs`,
  `graceful-shutdown-epipe-resilience.mjs`, `epipe-tolerant-stdio.mjs`, `trust-lock-incarnation-guard.mjs`,
  `crashlog-supervisor-rotation-parity.mjs`, `epipe-tolerant-stdio-supervisor-parity.mjs`,
  `project-memory.mjs`, `session-archive.mjs`, `companion-lead-mode.mjs`, `decisions-for-tool.mjs`,
  `emit-compare-branch-capture-order-guard.mjs`, `emit-compare-transpile-target-narrowing.mjs`,
  `gate-intent-no-firing-coupling.mjs`, `give-up-exhausted-durable.mjs`,
  `inert-skip-branch-capture-order-guard.mjs`, `log-message-content-gate.mjs`, `operator-surface.mjs`,
  `orchestration-mcp-role-guard.mjs`, `pty-codex-agnostic-methods.mjs`,
  `redelivery-parked-notice-suppression.mjs`, `redirect-discoverability.mjs`,
  `recycle-successor-onexit-wiring.mjs`, `setup-project-init-rest.mjs`, `setup-templates-rest.mjs`,
  `shell-terminal.mjs`, `skill-edit.mjs`, `emit-compare-soundness-single-definition-guard.mjs`,
  `emit-compare-soundness-guard.mjs`, `project-memory-control-chars.mjs`,
  `quarantine-reason-windows-guidance.mjs`, `graceful-teardown-hard-exit-backstop.mjs`,
  `merge-staged-dirt-lock-race.mjs`, `halted-recycle-pending-schema-migration.mjs`.
- **`CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS`**: `gate-runner-harness-marker-coupling.mjs`,
  `test-daemon-codex-real-spawn-preset.mjs`, `test-daemon-fixture-import-guard.mjs`,
  `test-daemon-port-allocation.mjs`.
- **CLAUDE.md trigger bullets not already covered above**: `agent-prompt-lint-surface-drift.mjs`,
  `agent-prompt-lint.mjs`, `surface-subset.mjs`, `audit-surface.mjs`, `mgmt-surface.mjs`,
  `setup-surface.mjs`, `user-audit-surface.mjs`, `platform-elevated-surface.mjs`,
  `platform-mgmt-surface.mjs`, `my-context-gate.mjs`, `companion-capability-grants.mjs`,
  `peer-message.mjs`, `task-delete.mjs`, `platform-agent-update.mjs`, `worker-status-projection-guard.mjs`,
  `entity-row-fields-guard.mjs`, `agent-session-full-field-guard.mjs`, `platform-config-redaction-drift.mjs`,
  `mcp-project-fields-chokepoint-guard.mjs`, `project-mcp-sessionenv-redaction.mjs`,
  `project-response-redaction-drift-guard.mjs`, `pty-prompt-mismatch.mjs`,
  `prompt-mismatch-unmatched-push.mjs`, `prompt-mismatch-unresolved-excerpt.mjs`, `pty-write-seq-log.mjs`,
  `canonical-git-helper-guard.mjs`, `canonical-git-isolation.mjs`.
- **Active work (card rule 4)**: 32 `merge-quarantine-*.mjs` files + `batch-merge-index-lock-not-cached.mjs`,
  `bounded-git-index-lock-log.mjs`, `canonical-index-lock-refusal.mjs`,
  `merge-confirm-verdict-cache-index-lock.mjs`, `merge-writer-index-lock.mjs`.

## Helper/fixture modules (51 files) — not classified, one note

Underscore-prefixed files (`_guard.mjs`, `_wait.mjs`, `_tmp-fixture.mjs`, `_hermetic-port.mjs`, etc.) are
excluded from test discovery and are shared infrastructure, not tests — KEEP/MERGE/REMOVE doesn't apply to
them the same way. One sub-family stood out on a skim and is worth a human look even though it's outside
this card's scope: **17 `_probe-*.mjs` files** (`_probe-classifier-search-59a88ac1.mjs`,
`_probe-collapsed-placeholder-identity.mjs`, `_probe-composer-clear*.mjs` ×3,
`_probe-context-scan-latency.mjs`, `_probe-empty-paste-provocation.mjs`,
`_probe-paste-*.mjs` ×5, `_probe-repaint-wedge.mjs`, `_probe-resume-mode.mjs`,
`_probe-session-name.mjs`) read like one-off manual investigation scratch scripts (several carry an
incident-hash suffix like `-59a88ac1`) rather than reusable shared fixtures the way `_guard.mjs`/`_wait.mjs`
are. This round did not check whether anything still imports them — that's a different kind of audit
(orphaned-helper, not redundant-test) and wasn't requested, but it's a plausible second round of cleanup if
the owner wants it.

## Cluster findings

### C1 — merge / worktree / batch-merge (166 files): 166 KEEP, 0 MERGE, 0 REMOVE-CANDIDATE
Exceptionally well-curated. The thing that looked most suspicious at a glance — many files sharing
near-identical boilerplate headers and naming families (`batch-merge-gate-history.mjs`/`-edge.mjs`,
`merge-confirm-verdict-cache.mjs`/`-squash-refusal.mjs`/`-retry-links.mjs`,
`merge-gate-reuse.mjs`/`-admission.mjs`/`-robustness.mjs`, etc.) — turned out on close reading to be
**explicit, documented splits**: each header cites measured per-file run times near/over the harness's
120s single-file ceiling and states exactly which lettered scenarios moved to which file, with "zero
deleted at any split." These are deliberate non-overlapping partitions that exist *because* the single-file
version was too slow for the harness — merging them back would reintroduce the exact problem the split
fixed. The 6 in-cluster files on card `b801bad0` were cross-checked against each other and their
out-of-cluster siblings (`mainline-watch-*.mjs`); all explicitly cross-reference each other and state what
they deliberately don't re-test. No overlap found.

### C2 — companion (105 files): 105 KEEP, 0 MERGE, 0 REMOVE-CANDIDATE
~35 of the 105 files were read in full depth, targeting every name-collision cluster that looked like a
plausible duplicate (`unbind-*` ×3, `outbound-suppression` vs `route-unbound-suppression`, `media-out` vs
`media-out-inapp`, `persona-reinject` vs `refresh-persona`, the trust-window/attestation/friction
primitive-layer files, `zero-reply` vs `reply-status`, the card-`2b26035c` family, `multi` vs
`multichannel`, `restricted-tools-rest` vs `codex-restricted-tools-refusal`). Every pair keyed off a
genuinely distinct trigger condition, DB table, call site, or card; most headers explicitly cross-reference
the sibling file to disambiguate scope. Spot-checked two live-code claims (`ASSISTANT_BASE_BRIEF`, `wake_me`)
against src — both still live, no dead-feature test found.

### C3 — pty (98 files): 98 KEEP, 0 MERGE, 0 REMOVE-CANDIDATE
The assigned lead (card `ba4eebc1`, cited by 14 files) turned out to be a **false positive by construction**:
every one of the 14 citations is identical boilerplate about deleting a locally-copied `waitUntil()` helper
in favor of the shared `_wait.mjs` import — an infra-dedupe note, unrelated to each file's actual
substantive regression target. Each file's *real* card (13 distinct card ids across the 14 files) was
verified by reading the root-cause prose, not just the title, confirming no two assert the same thing under
different names. Also pressure-tested several other near-neighbor families (`giveup-retired-signature` ×4,
`mode-*` ×4, `posix-enumeration` ×3, `root-reap` ×6, and others) — all distinct, several explicitly
cross-referencing siblings to declare non-overlap by design.

### C4 — worker / task / tasks (134 files): 134 KEEP, 0 MERGE, 0 REMOVE-CANDIDATE
Unusually clean. Checked all three assigned card-id leads (`86c9bdbd`, `43f5b242`, `2281009d`) directly: the
first had only 1 file in-cluster; the second's 2 citations were incidental infra notes with no assertion
overlap; the third's 7 citations were mostly one-line regression-safety comments noting their own scenario
*wasn't* broken by a shared mechanism change — only one of the seven is the dedicated test for that card's
actual fix. The `task-*-migration.mjs` family, the `worker-idle-*-parked.mjs` family, and the
`task-defer*`/`task-deferred-*` family each share a harness *recipe* but guard disjoint subject matter, and
several files explicitly state what their siblings already cover. No test matched a "feature since removed"
shape (spill.ts, PendingOpRegistry, CapQueueRegistry, classifyIdleWorker all still live).

### C5 — codex / recycle (77 files): 77 KEEP, 0 MERGE, 0 REMOVE-CANDIDATE
The three assigned card-id leads (`c976f009`, `f9360c84`, `4e026f35`) had zero hits in this cluster. A
large share of files explicitly state what they deliberately do *not* cover in their own headers. Full-read
(not just header) comparison on the pairs that looked most like duplicates on a skim — the two
`codex-real-spawn-lock` arithmetic files (unit vs. wiring-integration split), two cache-LRU files (different
caches, same bug pattern independently discovered), the ~9-file "real-spawn" family, two
"fleet-resolved-after-halted-*" files (boot/restart trigger vs. in-process-watch trigger), and two
"stopping predecessor/successor" files (explicitly documented as reaching *opposite* answers to analogous
questions, with an explicit instruction not to unify them) — none turned out to be true duplicates.

### C6 — platform / vault / gate / project / skills (146 files): 145 KEEP, **1 MERGE**, 0 REMOVE-CANDIDATE
Round 1's only finding — see "Round 1's finding — DONE this round" below. Several filename clusters
that looked superficially redundant (8 `platform-escalate-*.mjs`, 5 `vault-pause-lease*.mjs`, 10
`project-memory-*.mjs`, ~19 `gate-status*`/`gate-timeout*`/`gate-runner*` files, ~13 `skills-inject*.mjs`)
each cited a distinct card id and concrete incident/field, with headers cross-referencing siblings and
naming what each one doesn't cover.

### C7a — long tail A (344 files): 344 KEEP, 0 MERGE, 0 REMOVE-CANDIDATE
Cross-referenced every shared card id among ≥2 files in this slice (15 distinct groups, ~40 files) and
every visually-similar-name cluster (`mainline-watch-*` ×16, `idle-*` ×10, `cli-*` ×14, `kanban`/`column-*`
×5, `no-gate-by-design-*` ×3, `bounded-git-*` ×4, `credential-*` ×4, `dist-importer-*` ×3, and others).
Every grouping resolved to a deliberate, explicitly cross-referenced split (round 1 vs. round 2/3 of a fix
at different layers; pure-logic vs. real-spawn/real-git integration companions; two different triggers into
the same shared fix). Grepped for self-reported dead-code language ("superseded"/"no longer"/"deleted"/
"obsolete") specifically to find tests of removed functionality — all hits were files narrating their own
prior-round evolution while still asserting *current* behavior, not tests of something actually gone.

### C7b — long tail B (344 files): 344 KEEP, 0 MERGE, 0 REMOVE-CANDIDATE
Investigated ~35 suspect near-neighbor groups in depth (`peer-message-*`, `question-*`/`questions-*`,
`rotation-gate-*`, `win-job-launcher-*`, `usage-sampler` vs `usage-samples`, `scheduler.mjs` vs
`scheduler-*`, `wake.mjs` vs `wake-*`, `profile*`/`profiles*`, `ws-fleet*`/`ws-*-hardening`, and more).
Every near-name collision resolved to genuinely distinct coverage — different cited card ids, different
incidents, or an explicit cross-reference naming the sibling and what it does not cover. This corpus
deliberately layers unit vs. integration vs. production-wiring vs. migration-boot-test coverage for the
same feature across separate files, each pointing at its siblings.

## Round 1's finding — DONE this round

| file | verdict | evidence | confidence | time-saved tier |
|---|---|---|---|---|
| `packages/daemon/test/skills-research-unbundle-retire.mjs` | **MERGED** into `packages/daemon/test/skills-codescape-unbundle-retire.mjs` — **EXECUTED, commit `5254896d`** | Near line-for-line duplicate (124 vs. 122 lines) of the same `retireOrphanedBundledSkillDirs()` / `RETIRED_BUNDLED_SKILL_NAMES` mechanism proof (`packages/daemon/src/skills/store.ts`) — identical 5-part structure (pristine-retired / idempotent-second-run / customized-survives / falsification-red / falsification-green), differing only by the literal skill name substituted throughout (`codescape` vs. `research`) and the header's cited incident (card `187873f9` — `codescape` shipped then unbundled, published v0.3.0-v0.12.0 — vs. card `426dbb37`, the same shape for `research`). Verified independently (not just trusting the sub-review): diffing `research`'s file with every `codescape`→`research` text swapped back confirms the executable body is the same mechanism test, not a different one. The only thing the `research` file actually proved that the `codescape` file didn't is a one-line `RETIRED_BUNDLED_SKILL_NAMES.includes("research")` allowlist-membership check — not a reason to carry a second ~125-line generic-mechanism harness. | high | small — both are hermetic, in-process, fs-only tests with no spawn/git; the per-run cost of the duplicate is low, so the time saved is in the "one fewer file" ledger, not wall-clock seconds. |

**Done**: `skills-codescape-unbundle-retire.mjs` now loops `runUnbundleRetireCase(name)` over
`["codescape", "research"]` — every one of the 13 PASS lines each name had before still runs, for both
names (26 PASS total), just in one file instead of two. `skills-research-unbundle-retire.mjs` is deleted.
No reference to the deleted filename existed in `worktrees.ts`'s curated lists, `CLAUDE.md`, or any
decision record — grepped before deleting. Verified: ran the merged file directly (26/26 PASS) and
`pnpm --filter @loom/daemon guards` (30/30 guards pass, including `working-tree-eol-guard.mjs`). Commit
`5254896d`. `skills-dev-only-retirement-coverage.mjs` was unrelated (a drift guard between
`DEV_ONLY_SKILLS` and `RETIRED_BUNDLED_SKILL_NAMES`, not a mechanism proof) and is unaffected.

## Round 2 — COST lens: the 40 slowest test files, by real current timing

Read `~/.loom/gate-timing/daemon-per-file-timing.ndjson` (read-only, by absolute path; the owner explicitly
authorized this for this round; nothing was written back to `~/.loom`, nothing was copied into the repo,
the database was never opened). This is the daemon's own live per-file timing telemetry, current as of
today — not the ~10-week-stale committed snapshot round 1 used. 1547 distinct file names have timing data,
across 3497 run-summary rows from 2026-08-01 through 2026-10-13.

**10 of the top 40 are already protected or already recognized as expensive-by-design** — not re-opened
this round:

| file | recent median | why excluded from re-judgment |
|---|---|---|
| `canonical-git-isolation` | 140.8s | PROTECTED — CLAUDE.md canonical-git-tests trigger |
| `merge-quarantine-batch` | 105.8s | PROTECTED — active-work carve-out (rule 4) |
| `gate-status` | 102.1s | `ISOLATED_REAL_SPAWN_BASENAMES` — deliberately isolated, already judged expensive |
| `merge-gate-inert-diff` | 94.6s | `ISOLATED_REAL_SPAWN_BASENAMES` |
| `merge-gate-reuse` | 87.1s | `ISOLATED_REAL_SPAWN_BASENAMES` |
| `merge-repo-mutex` | 78.2s | `ISOLATED_REAL_SPAWN_BASENAMES` |
| `emit-compare-gate` | 76.1s | `ISOLATED_REAL_SPAWN_BASENAMES` |
| `merge-staged-dirt-lock-race` | 69.0s | PROTECTED — `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` |
| `codescape-health-probe` | 65.9s | reviewed anyway (it was also in the open pool) — see below, JUSTIFIED |
| `kickoff-real-spawn` | 57.7s | PROTECTED (`ASSET_READING_TEST_REPO_PATHS`) **and** `ISOLATED_REAL_SPAWN_BASENAMES` |
| `gate-timeout-circuit-breaker` | 52.8s | `ISOLATED_REAL_SPAWN_BASENAMES` |

(`codescape-health-probe` and `dist-importer-check-glue` are not in any curated list, so both were sent to
the open-pool reviewers rather than skipped; both came back JUSTIFIED — see the tables below.)

**The other 30, read in full by two parallel reviewers (I personally re-verified the top finding):**

### JUSTIFIED (25 of 30) — real cost, no citable slack

`dist-importer-check-glue`, `batch-merge-late-range-commits`, `merge-reviewed-tip-refusal`,
`mainline-watch`, `merge-gate-interval`, `worktree-recycle-alias-protection`, `merge-rest-route-tracked`,
`merge-gate-single-file-retry`, `merge-landing-aborted-batch-refusal`, `ungated-landing-check`,
`pass-a-stuck-worktree-no-replay`, `merge-confirm-fail-identity-void`, `codescape-health-probe`,
`merge-gate-off`, `mainline-watch-batch`, `batch-merge`, `pending-op-settle-lineage`,
`mainline-watch-batch-edges`, `merge-confirm-verdict-cache-retry-links`, `merge-gate-retry`,
`emit-compare-gate-scope-reclassify`, `merge-gate-resume-remaining-steps`, `batch-merge-reduced-gate`,
`merge-batch-fallback-owner-recycle`, `batch-merge-retain-hold`.

Common pattern: nearly every one of these files' headers already document a PRIOR cost-optimization pass
(a file split because the unsplit version alone used ~94% of the 120s per-file ceiling — cards `b5af744d`,
`4e8e2d82`, `4dfc648a`; a blind-sleep-to-progress-keyed-poll conversion — cards `cc43c74d`, `44d1dfd8`,
`92b0f44e`, `3ce4e749`, `1aabf969`; a settle-delay DI seam shrinking a production constant for tests —
card `0faaaa55`, one file documenting an explicit 45s→1.2s reduction already done). Several cite measured
before/after numbers and real incidents showing a tighter value was tried and caused false
failures/flakiness (e.g. `codescape-health-probe.mjs`: 6/15 false restarts at a tighter interval under
synthetic contention vs. 0/15 at the current one). Where a file runs many scenarios, each is pinned to a
genuinely distinct git topology, code path, or trigger — several explicitly document why a
seemingly-similar neighboring scenario is NOT redundant with it.

### SPEEDUP-CANDIDATE (5 of 30) — concrete, citable slack. **Round 3 (this update): 3 executed, 1 skipped, 1 reverted.**

The owner authorized executing these, with a rule: never trade a fixed bound for a shorter fixed bound —
replace a hidden sleep/race-fallback with a WITNESSED wait, never a smaller magic number. Each attempted
fix was measured 3x before/after and RED-proofed (the file's key assertion confirmed to still fail under
the mutation it exists to catch, via a temporary, reverted production-src change) before committing.

| file | evidence | outcome |
|---|---|---|
| `merge-gate-interval-ordering.mjs` | `armRedWitness(ctx, boundMs = 8_000)` races a real event witness against an 8-second `setTimeout` fallback, called twice. | **REVERTED — unsafe.** See "Why `merge-gate-interval-ordering.mjs` was reverted" below: a genuinely event-driven replacement was built, RED-proofed to NOT catch the real bug (still green with the production fix reverted), diagnosed, and the file restored byte-for-byte to its original. |
| `emit-compare-gate-test-importers.mjs` | Scenarios (H) and (I) each independently build the same heavy real-corpus fixture. | **EXECUTED, commit `e7a59282`.** (I) now reuses (H)'s already-built worktree/baseSha/branch (safe: `computeEmitCompareGate` has no cross-call cache, @decision 758486bc — verified both scenarios still measure a genuine fresh multi-second scan, 28.3s/31.2s observed). Measured: before 105.7/101.4/103.0s (avg 103.4s), after 89.2/89.3/86.8s (avg 88.4s) — **~15s saved**, consistently (low variance both sides). |
| `merge-confirm-solo-finalize-tip-cas.mjs` | `makeRepo()` runs a real `git init` per scenario (17×). | **EXECUTED, commit `c0c0a29e`.** Template-repo + `fs.cpSync`, same pattern as `merge-gate-interval.mjs` (card `8b5e002d`). RED-proofed (see below). Measured: before 87.6/81.1/91.6s (avg 86.8s), after 83.3/101.7/93.0s (avg 92.7s) — **no measurable win this run**; the real `git init` savings (~17×300-400ms ≈ 5-7s) are real but small relative to this file's ~90s total (dominated by 17× real `createWorktree` calls, untouched), and get lost in host-load noise. Kept anyway: strictly removes subprocess calls, cannot be slower in principle, matches an already-reviewed sibling pattern. |
| `batch-merge-late-range-reunion.mjs` | `setup()`'s real `git init` (6×) + a separate "share one setup() across the 4 fail-closed scenarios" idea. | **PARTIALLY EXECUTED, commit `72f97381`.** Applied only the template-repo part (same low-risk pattern as above) — measured: before 67.8/74.0/68.9s (avg 70.2s), after 67.3/62.2/64.3s (avg 64.6s) — **~5.6s saved**, consistent direction. Deliberately did **NOT** pursue the shared-setup idea: two of the four fail-closed scenarios mutate the branch ref / project config destructively, so sharing would require reordering previously-fully-isolated state across scenarios — real new risk for a smaller expected gain than what the sibling file above just showed to be noise-level. |
| `merge-commit-kill-confirm.mjs` | Two fixed post-settle sleeps (5600ms, 9000ms) sized for a historical RED-era race. | **SKIPPED.** See "Why `merge-commit-kill-confirm.mjs` was skipped" below. |

**RED-proof performed**: reverted `soloFinalizeTipGuard`'s CAS tip pin (`expectedBranchTip`, the card
`cc9bce38` fix, `sessions/service.ts`) to `undefined` unconditionally — confirmed `merge-confirm-solo-
finalize-tip-cas.mjs`'s edited version correctly goes RED (25 of its checks failed, including the exact
ones the fixture-speedup touches, e.g. "(A) the worktree is retained") — then restored the file and
rebuilt, confirming GREEN again. This file was chosen as the representative case for the two fixture-
reuse-only speedups (`emit-compare-gate-test-importers.mjs`'s own change was separately verified by the
fact that scenario (I) still measured a genuine, fresh, multi-second real scan after the reuse — not a
cached shortcut — which is itself direct evidence the real code path is still exercised). Both edits are
scoped identically: they change ONLY how a fixture repo/worktree is constructed, never the assertion logic
or the production call sequence under test, so the RED-proof's finding (the mutation it exists to catch is
still caught) generalizes to the sibling change on the same grounds. A full second and third RED-proof
cycle (reverting card `758486bc`'s and the late-range reunion's own fixes) was not performed, given this —
a scope decision, not an oversight; flagged here rather than left silent.

**Aggregate time actually landed this round: ~20.6 seconds** (15s + 5.6s + ~0s), concentrated in 2 files
with a clean measured win and 1 with a correctness-neutral, unmeasurable-this-run change — well short of
the ~35-55s round-2 estimate, because the two largest theoretical contributors (`merge-gate-interval-
ordering.mjs`'s ~15s and `merge-commit-kill-confirm.mjs`'s ~6-9s) turned out to be unsafe/unfixable without
a genuinely different, riskier design. See the two "why" write-ups below for the full reasoning.

### Why `merge-gate-interval-ordering.mjs`'s speedup was attempted, found unsafe, and reverted

The attempted fix replaced the 8-second `setTimeout` fallback with a race between the real `guardAcquired`
event (already hooked via `acquireRepoGuardOnly`) and `recordMergeGateFailure`'s own completion — a
genuinely event-driven design with zero fixed-duration wait. Built it, ran the file 3x before/after (saw
the expected ~15s improvement), then ran the mandated RED-proof: reverted the production ordering
`gate-semaphore.ts`'s `runExclusive` guarantees (@decision `593cedc8` — `beforeRelease` runs, and the slot/
repo guard release happens, strictly after it) by moving the repo-guard release to run BEFORE
`recordMergeGateFailure`, simulating the exact pre-fix bug this file's (W)/(WB) scenarios exist to catch.

**The rewritten witness came back GREEN anyway** — it did not catch the reintroduced bug. Diagnosis: the
race I built resolves against `recordMergeGateFailure`'s own completion, which is a fast, synchronous,
sub-millisecond-to-low-millisecond operation (a DB write). But the actual thing the original 8-second
window was giving time to is NOT `recordMergeGateFailure`'s own duration — it's the COMPETING solo
confirm's own multi-step REAL git/DB sequence (a `resolveGitRef` call, `computeWorktreeGateStamp`, then
`acquireRepoGuardOnly`) reaching and resolving its own guard acquisition, which takes genuinely more wall-
clock time than my fast replacement event ever waited. Racing against a fast event structurally cannot
give the competing side a fair chance to exhibit the bug — there is no way to make this witnessed without
EITHER reintroducing a real wait of comparable duration (which the owner's rule against a shorter fixed
bound forecloses in spirit, since the thing being waited for is still "however long it takes," not an
observable condition with a terminal signal), or without racing against a THIRD-PARTY signal (the
competing confirm fully settling) that is itself causally downstream of this function returning — which
deadlocks, since the production code cannot complete the very thing we'd be waiting to observe until our
own wrapped call already returns. **Reverted the test file and `gate-semaphore.ts` to HEAD, rebuilt,
confirmed GREEN on the original 8-second version.** No change committed for this file.

### Why `merge-commit-kill-confirm.mjs`'s speedup was skipped

The two flagged sleeps (`wait(HOOK_TOTAL_MS + SETTLE_MARGIN_MS)`, `wait(A_ADD_DELAY_MS + SETTLE_MARGIN_MS)`)
sit AFTER `mergeBranch()` has already resolved (kill already confirmed by then) and exist, per the closest
reading of the file's own extensive header doc, to let a lingering OS-level subprocess tree (a hook's own
`sh`/`node` descendants, possibly still flushing output or holding file handles even after the tracked
process is confirmed dead) finish naturally before the test inspects `.git` state and before cleanup
removes the temp repo directory. There is no JS-observable condition to poll for this — the thing being
waited on is subprocess/OS-level completion invisible to the test's own code without adding real new
instrumentation (e.g. having each hook script write its own "done" marker file, which several OTHER
scenarios in the same file already do for exactly this reason, but retrofitting it onto these two specific
sleeps is a materially bigger, riskier change than a timing tweak, on a file whose own header already
documents multiple rounds of hard-won, delicate timing-ratio tuning for its RED reproductions). Skipped
without attempting a code change, per the card's own "if a speedup isn't safe, skip it and record why."

## Round 2 — VALUE lens: does the file assert anything that actually needs a test

Re-reviewed all 1414 open files against four narrow tests (prose/comment-only assertion; whole-file
trivial constant/getter/type-shape check; dead feature/flag; byte-for-byte sibling duplicate) — looking at
what each file's `check()`/`assert()` calls actually exercise, not its header narrative. Result: **1
confirmed REMOVE-CANDIDATE, 1 candidate considered and rejected, 0 others** across all 8 clusters (1412
files cleared all four tests).

### Confirmed and DELETED: `worker-skill-dev-server-reference-split.mjs` — commit `1e3758fa`

**Personally verified by reading the full file.** Every one of its 9 `check()` calls does ONE thing: reads
two Markdown doctrine files (`assets/skills/worker/SKILL.md` and `assets/skills/worker/references/
dev-server-verification.md`) and checks whether a literal string (`"loom-dev-server-*.log"`, `"trace
UPWARD"`, `"EPERM"`, a relative-path string, `"worker_report"`, `"**Verify before reporting.**"`) is
present or absent in that text. There is no `../dist` import, no call into any real daemon code, no DB, no
MCP tool, no return value or side effect of actual logic checked anywhere in the file — it is purely
"reads a doc file and greps for sentences," the exact shape of the owner's category 1. (It is a
well-constructed example of that shape — it has a negative control, checks both directions of the split,
and checks a two-hop reference chain — but the construction quality doesn't change what category it's in:
none of that is a BEHAVIORAL check.)

**Deleted this round (commit `1e3758fa`), after checking**: not named in `worktrees.ts`'s curated lists,
`CLAUDE.md`, or any decision record; `role-surface-tools-named-in-doctrine.mjs` and `agent-prompt-lint`
don't reference it. The doctrine split it guarded — `SKILL.md` pointing to `references/dev-server-
verification.md`, which chains onward to `references/browser-verification.md` — is still structurally
present in the real skill files (verified directly by grep); the skill text itself remains the source of
truth for that split going forward, this test was never required for it to hold. Time saved: negligible
wall-clock (a single hermetic file-read test); the real benefit is one fewer file maintained against doc
drift (its own header already flagged that a future reword would need this test updated).

### Considered and REJECTED: `gate-verdict-field-classification-exhaustive.mjs`

A reviewer flagged this one at low-medium confidence with an explicit counter-argument attached, asking the
aggregator to judge. **Personally read the full file and reject it as a candidate.** On the surface it
looks like category 2 ("trivial... type shapes that the compiler already enforces") — its own header
admits the invariant it checks (every member of the `PendingGateOpVerdict` interface has a classification
entry in `GATE_VERDICT_FIELD_CLASSIFICATION`) is ALSO enforced by TypeScript's own excess/missing-property
check on that `Record<K,V>` literal, as a compile error.

But that is not what it actually is once you read what it's FOR and how it's built:
- **It's a cross-project-sensitive-field redaction chokepoint, not a type exercise.** The classification
  decides which `gate_status` fields are safe to show across projects; an unclassified field defaults to
  LEAKED, not blocked. This is the load-bearing mechanism, not incidental.
- **The compiler guarantee it mirrors already failed to prevent a real incident** — the file's own header
  cites a SIBLING branch (card `67030bb9`) that shipped a real new field, `batchBranchCount`, unclassified,
  landing concurrently with this fix.
- **The reason it's reimplemented outside `tsc` is structural, not redundant**: this project's own CLAUDE.md
  defaults every worker to running targeted test files directly, without a full build
  (`pnpm --filter @loom/daemon build`) — the compiler check this file mirrors is NEVER evaluated on that
  path. Without this file, a worker following the project's own documented default workflow gets ZERO
  warning of a newly-leaked field until the full gate (or a human) catches it — which is exactly how the
  real `batchBranchCount` incident happened.
- **It is falsification-proven in FOUR distinct, independent directions** — not asserted once and trusted:
  a field added with no classification (the real incident shape), a stale classification entry removed, a
  VERDICT-content classification entry removed by hand (mirrors a real, manually-reproduced `tsc` failure
  from development), and an OUTER-key classification entry removed by hand (the specific gap a later Code
  Review finding, card `753b9699`, closed). Each RED proof is a real source-text mutation, not a
  hypothetical.

This is the opposite of "a trivial getter/constant check" — it's a security-shaped chokepoint guard with a
demonstrated real-world failure mode, reimplemented specifically to close a gap in this project's own
testing *doctrine* (not a gap in the compiler). Kept, no action recommended.

## Ranked candidates — status after round 3 (execution)

1. **DONE — `skills-research-unbundle-retire.mjs` merged into `skills-codescape-unbundle-retire.mjs`.**
   Commit `5254896d`. Time saved: small (one fewer ~125-line hermetic file).
2. **DONE — `worker-skill-dev-server-reference-split.mjs` deleted.** Commit `1e3758fa`. Time saved:
   negligible wall-clock; one fewer file maintained against doc drift.
3. **DONE — `emit-compare-gate-test-importers.mjs`: (I) reuses (H)'s already-built fixture.** Commit
   `e7a59282`. Measured: **~15s saved** (103.4s → 88.4s avg), consistently across 3 runs each side.
4. **DONE — `batch-merge-late-range-reunion.mjs`: template-repo fixture for `setup()`.** Commit
   `72f97381`. Measured: **~5.6s saved** (70.2s → 64.6s avg).
5. **DONE, correctness-neutral — `merge-confirm-solo-finalize-tip-cas.mjs`: template-repo fixture for
   `makeRepo()`.** Commit `c0c0a29e`. Measured: **no clear win this run** (86.8s → 92.7s avg, within host
   noise) — kept anyway since it strictly removes subprocess calls and matches an already-reviewed sibling
   pattern.
6. **REVERTED — `merge-gate-interval-ordering.mjs`.** Attempted a genuinely event-driven replacement for
   the 8-second `armRedWitness` bound; RED-proofed it against the real production bug and found it did NOT
   catch the bug (the race resolved against the wrong, too-fast signal). Reverted byte-for-byte to the
   original 8-second version. No commit for this file; see the write-up above for the full diagnosis.
7. **SKIPPED — `merge-commit-kill-confirm.mjs`.** No JS-observable condition exists to replace either
   flagged sleep without new instrumentation (marker files in the hook scripts) that would be a materially
   bigger, riskier change than this card's scope. No attempt made beyond identifying this.

**Considered and explicitly NOT recommended**: `gate-verdict-field-classification-exhaustive.mjs` — looked
like a compiler-redundant constant check on the surface, but is a falsification-proven redaction
chokepoint with a real incident behind it (see above). Listed here so a future reviewer doesn't re-flag it
without re-reading why it was rejected.

## Estimated total time saved

**Executed this round: ~20.6 seconds of measured, verified wall-clock** (15s + 5.6s + ~0s net), plus two
files removed from the corpus (one merge, one delete) — small relative to a 52-minute gate, but real,
measured (not estimated), and verified not to weaken any coverage (RED-proofed where the change touched a
fixture a real invariant depends on; reverted outright where a RED-proof showed a real risk). The original
round-2 estimate of ~35-55s did not fully materialize: the two largest theoretical contributors
(`merge-gate-interval-ordering.mjs`'s ~15s, `merge-commit-kill-confirm.mjs`'s ~6-9s) turned out to be
unsafe or unfixable within this round's scope once actually attempted and verified — see the two write-ups
above. If the owner wants a bigger dent in the 52-minute figure, the better-evidenced levers remain
**suite growth** (+2.26x file count in ~10 weeks — see above) and the already-known-expensive, already-
isolated real-spawn/real-git integration files (`ISOLATED_REAL_SPAWN_BASENAMES`) — neither of which is a
"redundant test" or "doesn't need a test" in the sense the card was looking for.

## Scope limits (round 1 + round 2 — say plainly what was not checked)

- Round 1 was a **header/digest-first, pattern-and-lead-driven** review for simple redundancy, not a full
  line-by-line read of all 1414 open files. Round 2's VALUE lens went one level deeper (actual assertion
  labels, not headers) for all 1414 files, but still relied on digest-scanning at scale for the two
  344-file long-tail clusters — every file's assertion LABELS were extracted and read, but only the ones
  whose labels looked suspicious were opened in full for source.
- Cross-cluster duplication (a file in C2 semantically duplicating one in C6, say) was not exhaustively
  checked in either round — only within-cluster collisions and the explicit cross-cluster leads supplied
  were checked. A full all-pairs semantic comparison across 1414 files remains out of scope.
- The COST lens only covered the top 40 slowest files by current real timing data — it says nothing about
  whether a MEDIUM-cost file (not in the top 40) has slack. A file with a shortenable sleep that still
  finishes in, say, 3 seconds would not have been caught this round.
- The 51 underscore helper files were not checked for orphaning (unused helpers) — see the `_probe-*.mjs`
  note above.
- `~/.loom/gate-timing/daemon-per-file-timing.ndjson` was read once, read-only, for this round's COST lens,
  under the owner's explicit scoped authorization — it was never written to, never copied anywhere, and
  the daemon's database was never opened.

## What was executed across this card's three rounds

1. **Round 1 → round 3**: the round-1 MERGE, commit `5254896d` — `skills-research-unbundle-retire.mjs`
   deleted, folded into `skills-codescape-unbundle-retire.mjs`.
2. **Round 2 → round 3 (VALUE lens)**: `worker-skill-dev-server-reference-split.mjs` deleted, commit
   `1e3758fa`.
3. **Round 2 → round 3 (COST lens), 3 of 5 speedups executed**: `emit-compare-gate-test-importers.mjs`
   (commit `e7a59282`, ~15s saved), `batch-merge-late-range-reunion.mjs` (commit `72f97381`, ~5.6s saved),
   `merge-confirm-solo-finalize-tip-cas.mjs` (commit `c0c0a29e`, correctness-neutral, no measured win).
4. **1 reverted after RED-proofing it unsafe**: `merge-gate-interval-ordering.mjs` — no commit, file is
   byte-identical to before this card.
5. **1 skipped, no attempt**: `merge-commit-kill-confirm.mjs` — no safe witnessed-wait replacement
   identified without disproportionate new instrumentation.

All five commits ran `pnpm --filter @loom/daemon guards` (30/30 pass) before landing, and every edited
file's EOL was checked (`CR == LF`). Nothing was merged to mainline — these are commits on this card's own
branch, awaiting the owner's merge.
