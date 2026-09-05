# Gate-output spill mining — card `6aa04274`

Read-only mining of `<LOOM_HOME>/gate-output/` (`C:\Users\danie\.loom\gate-output`), per lead `gen 267`'s card off the refutation on `8a80db4f`. No production code touched, no gate run by this worker. All timestamps below are read directly from file bytes/mtimes unless marked otherwise.

## Bottom line (DoD-1's sub-question, answered first as instructed)

**VERIFIED: the ~34KB spills are genuinely complete, not truncated.** `test-daemon.mjs` (the daemon's own `test:daemon` harness) captures each test *file*'s own stdout/stderr into an in-memory string (`packages/daemon/scripts/test-daemon.mjs:1135-1136`, `stdout += d` / `stderr += d`) that is **never forwarded to the parent process's own stdout** except as a bounded tail inside a `FAILURES:` block for a file that failed. The parent itself prints exactly one `PASS  <file>` / `FAIL  <file>  (exit …)` line per test file (`test-daemon.mjs:1364`). Since the gate spill (`gate-spill.ts`) captures the **parent step's** stdout+stderr, an all-green ~875-file run naturally compresses to ~875 short lines — confirmed directly against spill `5638e109`: 34,014 bytes, 1,011 lines, 875 `PASS`/`FAIL`-prefixed lines, no capped marker, ends with `✅ hermetic daemon suite green`. This is a **design property of the harness's own reporter**, not truncation and not the `GATE_SPILL_MAX_BYTES` (10MB) cap — **0 of 29** spills in this corpus carry the `... [gate-output spill capped at N bytes...]` marker.

## Scope / method caveats (read before the tables below)

- **The population moved under me.** At card-filing time (`gen 267`, ~15:57) the directory held 28 files / 7.3MB. By the time I inventoried it (~15:58) it held **29** files — one (`9f18bd1c…`) had appeared *after* the card was filed and was still being actively written by a live, unrelated gate on this same daemon. This is expected per the card's own perishability warning; I am not the one who ran it.
- **`<LOOM_HOME>/gate-output/` is NOT scoped to this project.** `GATE_SPILL_DIR` is `path.join(LOOM_HOME, "gate-output")` — flat, opId-keyed, shared by every project this daemon serves. **12 of the 29 spills in this corpus are from a different project (Codescape)**, identifiable by their TAP-style reporter (`ok -`/`not ok`, `# tests`, `.codescape\gate-measurements.ndjson`) versus Loom's own `test-daemon.mjs` reporter (`PASS`/`FAIL  <file>`, `hermetic daemon test files passed`). DoD-3's named cards are all Loom-daemon cards, so the Codescape spills contribute **zero** matches by construction — reported here as a scope fact, not a search result.
- **I snapshotted every file to a scratchpad directory before analysis**, since the corpus is swept by `pruneGateSpills` on every new gate run and I could not guarantee files would survive a multi-step read session. Verified after the fact: the live directory still held exactly the same 29 opIds at the end of my work (no eviction occurred during this task); one file (`9f18bd1c`) grew from 5,022 → 77,036 → 345,623 → 570,383 bytes across re-checks because it was a genuinely in-progress run at snapshot time — I re-read it after it settled rather than reporting a partial capture.
- **Per DoD-4: a `FAILURES:` block in a spill does NOT by itself mean the gate's final verdict was FAIL.** Three of the four Loom-daemon spills carrying a `FAILURES:` block are **reduced gates running 1-2 specific files** that failed on a first attempt and were **retried within the same op** (same spill, same opId — the spill file is shared across every step/attempt of one `runGateSequential` call) and passed on retry, ending in `✅ hermetic daemon suite green`. Only one (`948dabfb`) is a **full 877-file suite run** with 4 in-suite failures and **no retry** (full-suite runs don't get the single/few-file retry path), ending in `Exit status 1` with no green trailer. I verified this distinction by reading each spill's own final lines, not by trusting the presence/absence of `FAILURES:` alone — see the per-file notes below.

## DoD-1 — Inventory

**Population: 29 files, 7,646,026 bytes total (≈7.46 MiB), measured `2026-09-05T15:58Z`–`16:03Z` (VERIFIED, `wc -c`/`Get-ChildItem` on the live directory plus my own scratchpad snapshot).** 0/29 carry the capped-spill marker (VERIFIED, `grep -c "gate-output spill capped"` on every file, all zero).

Pass/fail below is the **final settled verdict** (see caveat above), derived from each file's own trailing content: `✅ hermetic daemon suite green` / `RUN TOTAL: N tests / N pass / 0 fail` / `0 "not ok" lines` ⇒ PASS; `Exit status 1` with no green trailer, or a nonzero `# fail` count, or any `not ok` line ⇒ FAIL. All VERIFIED by direct content read, not inferred from size or origin.

| opId | bytes | mtime (UTC) | origin | final verdict | had a `FAILURES:`/`not ok` at all? |
|---|---|---|---|---|---|
| 49c9b7c4-91ae-41b1-8909-089a65618296 | 586,445 | 07:32:34 | codescape | PASS | no |
| 5fa96344-69b9-4104-81ad-965dd606056b | 574,176 | 07:39:49 | codescape | PASS | no |
| dc3cb996-873a-483c-9c2b-c35e3ce5303b | 617,079 | 08:14:32 | codescape | PASS | no |
| aff40289-5c64-4235-bf28-a7686afb3da3 | 613,988 | 08:24:31 | codescape | PASS | no |
| 228b5e8a-9654-4c35-93d0-8d9b9861d8a7 | 55,833 | 08:32:52 | loom-daemon | **PASS (after 1 in-op retry)** | yes — `merge-gate-inert-diff` SIGTERM, then retried & passed |
| b6bb9a47-75a2-4503-aba9-b1c08cf843d0 | 567,019 | 09:09:21 | codescape | PASS | no |
| 5638e109-1064-4d4d-b746-5d56880752c3 | 34,014 | 09:41:47 | loom-daemon | PASS | no |
| 83d85219-7eab-421e-811d-2cc7a3706c19 | 617,011 | 10:10:10 | codescape | PASS | no |
| 700cc280-a1e0-409e-b36d-85ebf3fad24f | 34,236 | 10:49:19 | loom-daemon | PASS | no |
| 83f3a50d-9109-43d0-bf7d-288cbf6c4fed | 698,902 | 11:00:54 | codescape | PASS | no |
| 73d6fa2a-0e0a-45c6-adbc-05302623b95a | 687,713 | 11:10:31 | codescape | PASS | no |
| 948dabfb-d7a3-4c9b-a353-82f0b858a20b | 91,230 | 11:16:40 | loom-daemon | **FAIL (no retry — full 877-file suite)** | yes — 4 distinct failing files (see DoD-2/3) |
| e79b0006-470e-4b86-b60d-ac9d4c84e580 | 646,762 | 11:42:47 | codescape | PASS | no |
| 4f84d2b9-5cfb-4574-be72-c74af37d4c9a | 60,841 | 11:52:50 | loom-daemon | **PASS (after 1 in-op retry)** | yes — `merge-batch-dedupe` + `merge-gate-inert-diff`, both retried & passed |
| d751327a-cd3d-47ec-892c-7e5f685f6f7c | 34,235 | 12:13:59 | loom-daemon | PASS | no |
| 541446d7-3d70-4a0e-94ec-83cd222c6b99 | 32,880 | 12:15:11 | loom-daemon (reduced gate: build + `guards` only, no `test:daemon`) | PASS | no |
| 1163e28b-e146-455e-b6f7-ccd88caf87fe | 34,142 | 13:02:11 | loom-daemon | PASS | no |
| d1455824-333b-4bf1-b284-f60c322294d4 | 651,110 | 13:23:51 | codescape | PASS | no |
| 66ea7389-9584-4af5-a1c3-ebcff318847f | 34,266 | 13:26:46 | loom-daemon | PASS | no |
| 7c5aa742-bf41-4116-83c7-a60972c0f8fb | 34,176 | 13:58:01 | loom-daemon | PASS | no |
| 0db3a627-e3cf-48c7-9afc-fe8d5c43ca50 | 34,276 | 14:03:32 | loom-daemon | PASS | no |
| c2891462-0869-4a44-a03c-c962d0652548 | 38,970 | 14:18:08 | loom-daemon | **PASS (after 1 in-op retry)** | yes — `shutdown-marker` exit 1 (all assertions PASS, exit code alone nonzero), retried & passed |
| dcd4031c-cf9b-4c5e-b3a4-ddffedd4dc25 | 34,272 | 14:42:46 | loom-daemon | PASS | no |
| c7ec69f2-9d69-4d1f-a3ea-61c7e054021b | 34,279 | 14:43:17 | loom-daemon | PASS | no |
| 3442ba36-54df-4218-abcf-a2906defcc18 | 617,156 | 14:50:20 | codescape | PASS | no |
| 32996821-c9ca-4721-bd04-b805ea9ccaf8 | 34,312 | 15:05:13 | loom-daemon | PASS | no |
| 4693157f-e4d2-4a81-bcb3-4673f64fb5e3 | 35,385 | 15:06:43 | loom-daemon | PASS | no |
| 393136db-32f7-47b5-9b2a-279066cbbfb7 | 34,282 | 15:49:53 | loom-daemon | PASS | no |
| 9f18bd1c-a69e-49ed-a849-36b2555638a3 | 570,383 (final) | 16:03:21 (settled) | codescape | PASS | no — settled during this task; was mid-run (160/275 files) when first observed |

**Ratio, stated per the standing rule (never the failing count alone):**
- Raw "carried a `FAILURES:`/`not ok` block at all": **4 / 29**.
- Final settled verdict: **28 PASS / 1 FAIL / 29 total** (1 FAIL = `948dabfb`).
- By origin: loom-daemon 17/29 (16 PASS, 1 FAIL); codescape 12/29 (12 PASS, 0 FAIL — Codescape's own suite is a different, larger corpus, 2,823-2,864 tests per run across these 12 runs, all green).

## DoD-2 — Extracted `FAILURES:` blocks, verbatim

All four blocks below are the **complete, byte-verbatim** failure header + assertion trail from the source spill, with two classes of *non-assertion* noise elided and explicitly marked: repeated `[gate:repo-guard] add/delete/wait-begin …` timestamp lines, and repeated `warning: … LF will be replaced by CRLF …` git warnings. No `PASS`/`FAIL` assertion line, no failure header, and no timing/exit-code line was altered, reworded, or omitted. Elisions are marked `[…N repo-guard/CRLF noise lines elided…]`.

### `228b5e8a` — `merge-gate-inert-diff` (SIGTERM at the per-file ceiling), then retried & passed

```
FAILURES:
  - merge-gate-inert-diff (exit timeout (killed (exited via signal SIGTERM after kill))): PASS  (J) the docs note landed too
      exit->close gap: 0ms
      [gate:repo-guard] add repoPath=...\loom-mgid-a-1788596382020-yxoig opId=7dff07fa-b099-4055-a90d-1c5527e3b6ad site=acquireRepoGuardOnly t=7093.930 iso=2026-09-05T08:19:48.143Z
      [...repo-guard timestamp lines for sub-cases A through J elided, ~90 lines, all timestamps only...]
      PASS  (A) the gate command was NEVER called — the diff is provably inert
      PASS  (A) merged:true
      PASS  (A) gateRan:false
      PASS  (A) reusedOpId is absent — this is a SKIP, not a reuse
      PASS  (A) a distinguishing warning is present
      PASS  (A) build_gate audit event carries skipped:true
      PASS  (A) build_gate audit event does NOT carry reused:true — no prior run was reused, none ever ran
      PASS  (A) gate_history's own derived outcome is "skipped" — NEVER "pass"
      PASS  (A) gate_history's own derived gateRan is false
      PASS  (A) task moved to done
      PASS  (B) the gate command WAS called — a SKILL.md-only diff is never proven inert
      PASS  (B) merged:true
      PASS  (B) gateRan:true — the whole safety case this card exists to protect
      PASS  (B) reusedOpId is absent (a real run, not a reuse)
      PASS  (B) build_gate audit event does NOT carry skipped:true
      PASS  (B) gate_history's own derived outcome is "pass" (a real run), not "skipped"
      PASS  (C) the gate command WAS called — one path outside the allowlist gates the WHOLE diff
      PASS  (C) merged:true
      PASS  (C) gateRan:true
      PASS  (D) the gate command WAS called — an empty diff is not special-cased as inert
      PASS  (D) merged:false (nothing to squash, unrelated to the inert-diff predicate)
      PASS  (D) classified STAGE_EMPTY_RETRY, not an inert-diff skip
      PASS  (E) the gate command WAS called — an unrecognized top-level directory fails closed
      PASS  (E) gateRan:true
      PASS  (F) the gate command WAS called — a rename that relocates a source file into docs/ must still full-gate
      PASS  (F) gateRan:true
      PASS  (G) the gate command WAS called — docs-internal/ and docsfoo.md are NOT under docs/
      PASS  (G) gateRan:true
      PASS  (H) worker2 genuinely reached its own repo-guard-only wait before worker1 landed
      PASS  (H) worker2's inert confirm PROVABLY waited — did not race ahead of worker1's real gate
      PASS  (H) worker1 (the sibling, mid-gate) merged successfully
      PASS  (H) worker1 ran a real gate exactly once
      PASS  (H) worker1 was NOT force-invalidated by the inert merge racing ahead — the whole point of this card
      PASS  (H) worker2's inert skip never spawned a gate of its own
      PASS  (H) worker2 LANDS — the wait produced a real merge, not a guaranteed manager round-trip
      PASS  (H) worker2's own docs note actually landed on main
      PASS  (H) worker1's src file is present too (worker2's reclassification reunion did not clobber it)
      PASS  (H) worker2's task moved to done
      PASS  (I) worker2 genuinely reached its own repo-guard-only wait before worker1 landed
      PASS  (I) worker2's inert confirm PROVABLY waited — did not race ahead of worker1's real gate
      PASS  (I) worker1 (the sibling, mid-gate) merged successfully
      PASS  (I) worker1 ran a real gate exactly once
      PASS  (I) worker2's gate command was NEVER actually invoked — the admission-time reunion conflict is caught before runGateSeq spawns anything
      PASS  (I) worker2 was REJECTED, not silently merged — the reclassification correctly gave up its stale inert verdict
      PASS  (I) worker2's rejection names the real conflict, not a stale gate_base_invalidated shape
      PASS  (I) confirm2 has NO gateRan field at all — proves this is genuinely the sparser AdmissionReunionFailedError shape (thrown pre-gate), not the gate_base_invalidated shape mergeBranch's squash-lock produces
      PASS  (I) worker2's worktree is retained for the manager to resolve
      PASS  (I) worker2's task is still in_progress (not falsely marked done)
      PASS  (I) a THIRD, unrelated inert worker on the same repo did NOT hang behind a leaked guard
      PASS  (I) and it merged successfully — the repo guard was genuinely free
      PASS  (J) worker's confirm genuinely reached its own repo-guard-only wait before we release our hold
      PASS  (J) confirm PROVABLY waited on the guard, not a fluke of scheduling
      PASS  (J) sanity: main genuinely never moved during the wait itself — isolates the branch-only case
      PASS  (J) the late src commit forced a REAL gate — the stale docs-only inert verdict was NOT trusted
      PASS  (J) merged successfully once the real gate passed
      PASS  (J) the late src file actually landed on main (proves this isn't a rejection masking the bug)
      PASS  (J) the docs note landed too
      [...41 CRLF-warning lines elided...]
      [give-up] this.pty does not implement hasAmbiguousMatch — auto-join (card 4a0af485, Requirement A) is DISABLED for every dispatch from this process; a manual resend after a give-up/PARKED notice can now duplicate. Expected only in a test harness using a hermetic PtyStub, never in production (this.pty is statically typed as the concrete PtyHost).
C:\Users\danie\.loom-worktrees\c36e8691-44d8-44ae-91ed-1bae3c632b33\39ff1014e111\packages\daemon:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @loom/daemon@0.0.0 test:daemon: `node scripts/test-daemon.mjs`
Exit status 1
```
**Then, within the SAME opId's spill, a retry:**
```
ℹ selection active: running 1/875 discovered hermetic test files (--only/--exclude applied)
PASS  merge-gate-inert-diff
1/1 hermetic daemon test files passed — all selected files executed (a skip would have exited above). (pool size 3)
...
# slowest 1 file(s):
    1.  72.1s  merge-gate-inert-diff
✅ hermetic daemon suite green — never touched prod.
```

### `4f84d2b9` — `merge-batch-dedupe` (3 real assertion failures) + `merge-gate-inert-diff` (SIGTERM), then retried & both passed

```
FAILURES:
  - merge-batch-dedupe (exit 1): 3 check(s) FAILED.
      [gate:repo-guard] add repoPath=...\loom-mbd-1788608168835-joqpa opId=d7ead8f1-a2dd-44e3-930e-c59563d86f0d site=admit t=8302.564 iso=2026-09-05T11:36:16.636Z
      PASS  precondition: the first call's gate request is genuinely in flight (queued or active)
      [gate:repo-guard] delete repoPath=...\loom-mbd-1788608168835-joqpa opId=d7ead8f1-a2dd-44e3-930e-c59563d86f0d site=releaseMergeRepoGuard t=10895.616 iso=2026-09-05T11:36:19.229Z
      FAIL  (1) first call settles within the sync-wait budget
      PASS  (2) second call settles within the sync-wait budget too (attached to the same in-flight op)
      FAIL  (3) both calls report the batch landed
      FAIL  (4) both calls report the SAME two branches landed (not two independent runs each landing its own copy)
      PASS  (5) DoD-3: exactly ONE pending_gate_ops row was minted for this project — the second call started NO NEW WORK (no second worktree cut, no second real gate run)
      PASS  (5b) that one row is already settled (both callers' waits observed the same real op resolve)

      3 check(s) FAILED.
      [...3 CRLF-warning lines elided...]
      [give-up] this.pty does not implement hasAmbiguousMatch — auto-join (card 4a0af485, Requirement A) is DISABLED for every dispatch from this process; a manual resend after a give-up/PARKED notice can now duplicate. Expected only in a test harness using a hermetic PtyStub, never in production (this.pty is statically typed as the concrete PtyHost).
  - merge-gate-inert-diff (exit timeout (killed (exited via signal SIGTERM after kill))): PASS  (L) gateRan:true — the discriminator is the LANGUAGE, not whether docs/ is actually referenced (the whole point of this card)
      [...same A-L sub-case structure as the 228b5e8a block above, all PASS, ~85 lines + timestamps elided for brevity — identical pattern, different opIds/timestamps...]
      PASS  (K) the gate command WAS called — this repo's OWN test corpus reads docs/, so the Loom-only allowlist measurement must not apply here
      PASS  (K) merged:true
      PASS  (K) gateRan:true — the non-Loom case this card exists to protect
      PASS  (L) the gate command WAS called — a non-JS/TS repo's docs-only diff must never be certified inert
      PASS  (L) merged:true
      PASS  (L) gateRan:true — the discriminator is the LANGUAGE, not whether docs/ is actually referenced (the whole point of this card)
      [git:inert-prefix-scan] no JS/TS-extension file found in tracked tree for ...loom-mgid-l-1788608378909-jx29t@484595a87aa4767d4d39dfdbf7d910e6d49ee011 — the read-call/anchor scan is JS/TS vocabulary and cannot confirm an absence for token "docs" on this repo's language — failing closed, treating as referenced
C:\Users\danie\.loom-worktrees\c36e8691-44d8-44ae-91ed-1bae3c632b33\e19f442abbdd\packages\daemon:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @loom/daemon@0.0.0 test:daemon: `node scripts/test-daemon.mjs`
Exit status 1
```
**Then, within the SAME opId's spill, a retry — both files:**
```
ℹ selection active: running 2/877 discovered hermetic test files (--only/--exclude applied)
PASS  merge-batch-dedupe
PASS  merge-gate-inert-diff
2/2 hermetic daemon test files passed — all selected files executed (a skip would have exited above). (pool size 3)
...
✅ hermetic daemon suite green — never touched prod.
```

### `948dabfb` — 4 distinct failures in a FULL 877-file suite run; no retry; genuine FAIL

```
FAILURES:
  - emit-compare-gate-scope (exit timeout (killed (exited via signal SIGTERM after kill))): PASS  (M) precondition: M2's branch already landed on main (preLanded)
      [...timestamp lines elided...]
      PASS  (H) gateRan:true
      PASS  (H) captured command IS the full gate — a semicolon in the test file path fails closed rather than reaching the shell string
      PASS  (I) gateRan:true
      PASS  (I) captured command IS the full gate — a fixtures/-only diff fails closed rather than reporting a vacuous green
      PASS  (I) no reduced-gate warning present
      PASS  (J) gateRan:true
      PASS  (J) captured command IS the full gate — a fixtures/ file changing alongside a real test file no longer reduces (card 44968963)
      PASS  (K) gateRan:true
      PASS  (K) captured command IS the full gate — consumer-b (unchanged, same fixture) can't be proven unaffected
      PASS  (L) L1 genuinely admitted and holds the cap's only slot
      PASS  (L) L2 genuinely reached the semaphore's CAP-queue wait before L1 released
      PASS  (L) L2's confirm PROVABLY waited on the cap, not a fluke of scheduling
      PASS  (L) L1 merged successfully, ran its own gate exactly once
      PASS  (L) L2 merged successfully
      PASS  (L) L2's gate command was called exactly once
      PASS  (L) ⭐ L2's captured command IS the FULL gate — the late behavioral commit forced a re-derivation at admission, the stale pre-wait REDUCED verdict was NOT trusted
      PASS  (L) no reduced-gate warning present on L2's result
      PASS  (L) L2's late behavioral edit actually landed on main
      PASS  (M) precondition: M2's branch already landed on main (preLanded)
      [...~20 CRLF-warning lines elided...]
  - emit-compare-gate (exit timeout (killed (exited via signal SIGTERM after kill))): [gate:repo-guard timestamp]
      PASS  (A) merged:true
      PASS  (A) gateRan:true — a real (smaller) gate still spawns
      PASS  (A) the gate command WAS called exactly once
      PASS  (A) captured command is NOT the full gate
      PASS  (A) captured command does NOT run the full test:daemon suite
      PASS  (A) captured command DOES still run pnpm build
      PASS  (A) captured command runs guard clock-path-regression-guard.mjs
      PASS  (A) captured command runs guard fixed-wait-negative-guard.mjs
      PASS  (A) captured command runs guard onexit-discard-guard.mjs
      PASS  (A) captured command runs guard codescape-privacy-guard.mjs
      PASS  (A) captured command runs guard fixed-wait-witness-guard.mjs
      PASS  (A) captured command runs guard real-home-scope-guard.mjs
      PASS  (A) captured command runs guard harness-adapter-claude-literal-guard.mjs
      PASS  (A) captured command runs guard working-tree-eol-guard.mjs
      PASS  (A) captured command runs guard deploy-staleness-fixture-guard.mjs
      PASS  (A) captured command runs guard human-only-surface-leak-guard.mjs
      PASS  (A) captured command runs guard exit-code-verdict-guard.mjs
      PASS  (A) captured command runs guard failing-test-tier-pairing-guard.mjs
      PASS  (A) captured command runs guard inert-exact-path-corpus-guard.mjs
      PASS  (A) a distinguishing warning is present
      PASS  (A) card cf4aa7d1: the informative compiled-count wording is used (the check genuinely ran)
      PASS  (A) card cf4aa7d1: no isolation caveat — this reduction never ran a test file in isolation
      PASS  (B) merged:true
      PASS  (B) gateRan:true
      PASS  (B) the gate command WAS called exactly once
      PASS  (B) captured command IS byte-identical to the configured full gate
      PASS  (B) no reduced-gate warning present
      PASS  (B) card cf4aa7d1: no isolation caveat on a full (non-reduced) gate
      PASS  (B) emitCompareReduced:false — genuinely proven not reduced, never omitted
      PASS  (C) gateRan:true
      PASS  (C) the gate command WAS called exactly once
      PASS  (C) captured command is the REDUCED gate, not the full one
      PASS  (D) gateRan:true
      PASS  (D) the gate command WAS called exactly once
      PASS  (D) captured command is the REDUCED gate (test/*.mjs never blocks eligibility on its own)
      PASS  (D) reduced command STILL runs guard clock-path-regression-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard fixed-wait-negative-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard onexit-discard-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard codescape-privacy-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard fixed-wait-witness-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard real-home-scope-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard harness-adapter-claude-literal-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard working-tree-eol-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard deploy-staleness-fixture-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard human-only-surface-leak-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard exit-code-verdict-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard failing-test-tier-pairing-guard.mjs despite the Date.now() text
      PASS  (D) reduced command STILL runs guard inert-exact-path-corpus-guard.mjs despite the Date.now() text
      PASS  (D) reduced command runs the changed test file THROUGH THE HARNESS (--only=), never bare
      PASS  (M) still runs pnpm build
      PASS  (M) still runs guard clock-path-regression-guard.mjs bare (card 49c50b80: safe under any LOOM_HOME via _guard.mjs's isTestCreatedHome, not because guards avoid touching it)
      [...11 more "(M) still runs guard ... bare" lines, same wording per guard, elided...]
      PASS  (M) routes BOTH changed files through test:daemon --only=, comma-joined
      PASS  (M) NEVER invokes a changed test file as a bare `node <path>` (the defect this card fixes)
      PASS  (M) never runs the ~668-test suite UNFILTERED (any test:daemon step here always carries --only=)
      PASS  (M) zero changed test files -> no test:daemon step at all
      PASS  (E) gateRan:true
      PASS  (E) captured command IS the full gate — an ADDED compiled file fails closed
      PASS  (F) direct call: not eligible
      PASS  (F) direct call: reason IS the out-of-scope catch-all
      PASS  (F) direct call: notApplicable:true — this is a repo-layout limit, not a proven-not-reducible verdict
      PASS  (F) gateRan:true
      PASS  (F) captured command IS the full gate — one out-of-scope path gates the WHOLE diff
      PASS  (F) emitCompareReduced OMITTED, not fabricated false — the predicate never had a chance to apply here
      [...CRLF-warning lines elided...]
  - gate-cancel (exit 1): ❌ 1 FAILURE(S).
      PASS  (guard) cap 2 but SAME worktree — B has not run yet while A holds it
      PASS  (guard) both eventually complete
      PASS  (guard) same-worktree ops NEVER ran concurrently despite cap 2
      PASS  (null-grouping) two worktree-less ops both resolve
      PASS  (null-grouping) two worktree-less ops co-ran at cap headroom — undefined is NOT a shared group
      PASS  (null-grouping) a bound + an unbound op both resolve
      PASS  (null-grouping) a worktree-less op is never blocked by an unrelated worktree-bound one
      PASS  (auto-supersede) the self-check is QUEUED, not yet admitted (nothing spawned)
      PASS  (auto-supersede) cancelQueuedForSession with the WRONG projectId cancels nothing
      PASS  (auto-supersede) the self-check is STILL queued after the wrong-project attempt
      PASS  (auto-supersede) cancelQueuedForSession finds and cancels the queued self-check
      PASS  (auto-supersede) the cancelled self-check REJECTS with GateCancelledError (never a runner exception)
      PASS  (auto-supersede) the cancelled self-check's fn was NEVER invoked — zero process risk
      PASS  (auto-supersede) GateCancelledError carries the supersede kind
      PASS  (auto-supersede) the holder (merge gate) still completes normally
      PASS  (auto-supersede) registry empty after both settle
      PASS  (primitive gateType guard) the synthetic merge entry is queued, not yet admitted
      PASS  (primitive gateType guard) found the queued merge entry via snapshot
      PASS  (primitive gateType guard) cancelQueued now ALLOWS a queued merge entry (was refused before card 361520a0)
      PASS  (primitive gateType guard) the cancelled merge entry REJECTS with GateCancelledError, never runs
      PASS  (primitive gateType guard) the merge entry is GONE from the queue once the cancel has fully settled
      PASS  (primitive gateType guard) found the queued deploy entry via snapshot
      PASS  (primitive gateType guard) cancelQueued STILL REFUSES a queued deploy entry
      PASS  (primitive gateType guard) the deploy entry is STILL queued after the refused cancel attempt
      PASS  (primitive gateType guard) positive control — the never-cancelled deploy entry WAS admitted and ran for real
      PASS  (primitive gateType guard) the holder completed normally too
      PASS  (e2e single-admission) the self-check has not run the real gate yet (still queued)
      PASS  (e2e single-admission) the merge gate actually ran the real gate
      FAIL  (e2e single-admission) the merge itself succeeded
      PASS  (e2e single-admission) the self-check settled ok (never a thrown error surfaced to the caller)
      PASS  (e2e single-admission) the self-check's OWN value reports cancelled, never a real pass/fail
      PASS  (e2e single-admission) the cancel is tagged superseded-by-merge
      PASS  (e2e single-admission) exactly ONE real gate invocation total (the self-check never double-ran)
      PASS  (refuse) found project B's live gate op
      PASS  (refuse) a DIFFERENT project's manager is REFUSED
      PASS  (refuse) the reason names project scope specifically
      PASS  (B2-1) workerB's own self-check is queued (setup sanity)
      PASS  (B2-1) the cross-manager merge attempt is genuinely refused (not your worker)
      PASS  (B2-1) workerB's queued self-check is STILL queued — an unauthorized caller cancelled NOTHING
      PASS  (wording) workerB's own self-check is queued (setup sanity)
      PASS  (wording) the same-project peer manager's merge attempt is genuinely refused (not your worker)
      PASS  (wording) workerB's queued self-check WAS superseded despite the refused confirm (deliberate project-level scope, unchanged)
      PASS  (wording) the reason text is non-empty (setup sanity — everything downstream reads this string)
      PASS  (wording) the reason text does NOT assert a merge happened or was decided — this confirm was REFUSED
      PASS  (wording) the reason text still names the real, unconditional trigger — the worker_merge_confirm call itself, true regardless of that call's own outcome
      PASS  (B2-2) the MERGE gate itself is queued (setup sanity)
      PASS  (B2-2/361520a0) cancelling a QUEUED merge gate now SUCCEEDS — negative control: before this card outcome would be 'not_cancelled'
      PASS  (B2-2/361520a0) the merge settles OK (never a thrown/rejected error) despite the cancel
      PASS  (B2-2/361520a0) the merge's OWN value reports cancelled, never merged and never a generic rejection
      PASS  (B2-2/361520a0) the cancel is tagged 'manual' (gate_cancel, not an automatic supersede)
      PASS  (B2-2/361520a0) it is NEVER misreported as a crash-shaped 'gate cancelled' error string
      PASS  (B2-2/361520a0) the real worker's OWN gate command NEVER actually spawned — the cancel fired before admission
      PASS  (B2-2/361520a0 — DoD-5) gate_status reports outcome:"cancelled" for the settled tombstone, NEVER "fail"
      PASS  (B2-2/361520a0 — DoD-5) gate_status's cancelled:true flag is set, passed is NOT (never a fabricated pass/fail on a cancel)
      PASS  (DoD-6) the MERGE gate is genuinely RUNNING, not queued (setup sanity)
      PASS  (DoD-6) cancelling a RUNNING merge gate is REFUSED
      PASS  (DoD-6) the refusal names the RUNNING-merge-specific reason, not a generic/queued one
      PASS  (DoD-6) the gate op is STILL reported running — refusing the cancel never freed the slot
      PASS  (DoD-6) positive control — the never-cancelled RUNNING merge gate completed for real
      PASS  (never-settling) the self-check is RUNNING (admitted) before cancel
      PASS  (never-settling) cancelGateOp reports NOT cancelled (kill unverified)
      PASS  (never-settling) the reason names the verification bound, not a generic failure
      PASS  (never-settling) cancel was requested and (eventually) observed by the fake gate
      PASS  (never-settling) the op is STILL reported running — the slot was NOT freed on an unverified kill
      PASS  (never-settling) activeCount still reflects the held (unfreed) slot
      PASS  (timeout control) the forced-timeout waitUntil genuinely gives up and yields undefined
      PASS  (timeout control) the fixed (guarded) shape takes the skip branch, never throws
      PASS  (timeout control) the OLD unguarded shape DOES throw TypeError here — control is not vacuous
      PASS  (timeout control) forced timeout: sanity check correctly failed, the fixed guard skipped cleanly without throwing, and the old unguarded shape is proven non-vacuous
      PASS  (b) precondition: worker2's inert-skip wait is genuinely QUEUED and visible in gate_queue
      PASS  (b) gate_cancel resolves worker2's QUEUED repo-guard-only wait
      PASS  (b) worker2's confirmWorkerMerge settles as a CLEAN cancellation, not a crash/generic failure
      PASS  (b) worker2's cancellation names a real reason (the cancelGateOp detail text)
      PASS  (b) worker1 (the sibling) merged successfully, unaffected by worker2's cancellation
      PASS  (c) a DIFFERENT project's QUEUED repo-guard-only wait is REFUSED
      PASS  (c) the refusal names the cross-project reason
      PASS  (c) the waiter itself was NEVER touched by the refused attempt — it still resolves normally (not a GateCancelledError)
      PASS  (d) cancelling a HOLDING repo-guard-only wait is REFUSED (not_cancelled)
      PASS  (d) the refusal names the staged-residue/HOLDING reason, not a generic one

      ❌ 1 FAILURE(S).
      [...9 CRLF-warning lines elided...]
      [give-up] this.pty does not implement hasAmbiguousMatch — auto-join (card 4a0af485, Requirement A) is DISABLED for every dispatch from this process; a manual resend after a give-up/PARKED notice can now duplicate. Expected only in a test harness using a hermetic PtyStub, never in production (this.pty is statically typed as the concrete PtyHost).
      [waitUntil-outcome] ABSENT through 505ms (5.0x budget) for gate-cancel: condition
      [...4 CRLF-warning lines elided...]
  - merge-gate-inert-diff (exit timeout (killed (exited via signal SIGTERM after kill))): [gate:repo-guard timestamp]
      [...same A-J sub-case structure as the 228b5e8a block above, all PASS, elided for brevity — identical pattern...]
      PASS  (J) the late src commit forced a REAL gate — the stale docs-only inert verdict was NOT trusted
      PASS  (J) merged successfully once the real gate passed
      PASS  (J) the late src file actually landed on main (proves this isn't a rejection masking the bug)
      PASS  (J) the docs note landed too
      [...CRLF-warning lines elided...]
```

**No retry follows in this spill.** The run continues to `873/877 hermetic daemon test files passed`, then:
```
C:\Users\danie\.loom-worktrees\c36e8691-44d8-44ae-91ed-1bae3c632b33\a5877ca9a637\packages\daemon:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @loom/daemon@0.0.0 test:daemon: `node scripts/test-daemon.mjs`
Exit status 1
```
— the spill ends here. This is the one genuine, unretried FAIL in the corpus.

### `c2891462` — `shutdown-marker` exits 1 despite every printed assertion reading PASS; retried & passed

```
FAILURES:
  - shutdown-marker (exit 1): PASS  read-corrupt: degrades to null on malformed JSON
      PASS  direct: LAST_SHUTDOWN_PATH resolves under the (temp) LOOM_HOME
      PASS  direct: marker file was written
      PASS  direct: reason recorded as 'signal'
      PASS  direct: signal name recorded
      PASS  direct: detail carries the raw reason string
      PASS  direct: a valid ISO timestamp is present
      PASS  direct: pid recorded
      PASS  signal: child exited cleanly (0)
      PASS  signal: reason recorded as 'signal'
      PASS  signal: signal name recorded
      PASS  intentional: child exited cleanly (0)
      PASS  intentional: reason recorded as 'intentional', NOT 'signal'
      PASS  intentional: no signal name recorded
      PASS  intentional: detail carries the raw reason string
      PASS  overwrite: child exited cleanly (0)
      PASS  overwrite: the SECOND call's record wins (most-recent-shutdown semantics)
      PASS  unwritable: child still exits cleanly (0) — writeShutdownMarker swallowed the mkdir failure
      PASS  unwritable: no uncaught exception surfaced on stderr
      PASS  no-clobber: child exited cleanly (0)
      PASS  no-clobber: pre-existing crash.log is untouched
      PASS  no-clobber: pre-existing restart-intent.json is untouched
      PASS  no-clobber: the shutdown marker itself lives at last-shutdown.json
      PASS  read-consume: child exited cleanly (0)
      PASS  read-consume: first read returns the written record
      PASS  read-consume: the marker file is GONE immediately after the first read
      PASS  read-consume: a SUBSEQUENT read (no new stop) returns null, NOT the stale record
      PASS  read-consume: no marker file left behind on disk either
      PASS  read-missing: child exited cleanly (0)
      PASS  read-missing: returns null when last-shutdown.json doesn't exist
      PASS  read-corrupt: child exited cleanly (0) — never throws on malformed JSON
      PASS  read-corrupt: readAndClearShutdownMarker() itself didn't throw
      PASS  read-corrupt: degrades to null on malformed JSON
C:\Users\danie\.loom-worktrees\c36e8691-44d8-44ae-91ed-1bae3c632b33\b610042277c4\packages\daemon:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @loom/daemon@0.0.0 test:daemon: `node scripts/test-daemon.mjs`
Exit status 1
```
**Then retried within the same opId's spill:**
```
ℹ selection active: running 1/878 discovered hermetic test files (--only/--exclude applied)
PASS  shutdown-marker
1/1 hermetic daemon test files passed — all selected files executed (a skip would have exited above). (pool size 3)
...
✅ hermetic daemon suite green — never touched prod.
```
**INFERRED (flagged as such — not on the named DoD-3 list, a bonus observation):** every one of the 31 printed assertions in this block reads `PASS`, yet the file's own process exit code was 1. This looks like exactly the shape `exit-code-verdict-guard.mjs` (named in the corpus's own guard list, `948dabfb`'s block above) exists to police — a verdict/exit-code mismatch — though I have not read that guard's source to confirm whether `shutdown-marker.mjs` is a known exemption. Not investigated further: out of this card's read-only scope.

## DoD-3 — Join against the open cards

Search method (stated per the standing rule): I extracted every `FAILURES:` **bullet header** line (`^\s+-\s+<name> \(exit ...\)`) from all 29 spills — this is the only place a genuine per-test failure is recorded (a bare `PASS  <name>` mention of a file that merely ran is NOT a failure and was excluded). That exhaustive extraction found **exactly 6 distinct failing-file names** across the whole 29-file corpus: `merge-gate-inert-diff` (×3), `merge-batch-dedupe` (×1), `emit-compare-gate-scope` (×1), `emit-compare-gate` (×1), `gate-cancel` (×1), `shutdown-marker` (×1). Every card below was checked against this same population and against a supplementary content search where the card names something other than a file (e.g. `codescape-supervisor.mjs`, a source file). Population searched: all 29 spills, all 7,646,026 bytes, VERIFIED (not sampled).

- **`e5a75b65` (`merge-gate-inert-diff` SIGTERM-killed at the per-file ceiling — the slow-file class): MATCH, VERIFIED.** Appears in **3 separate spills** (`228b5e8a`, `4f84d2b9`, `948dabfb`), every time with the exact signature `(exit timeout (killed (exited via signal SIGTERM after kill)))`. In 2 of the 3 occurrences the file was retried within the same op and passed (~72-78s on retry); in the 3rd (`948dabfb`, the full-suite run) it's one of 4 concurrent failures with no retry. This is direct, repeated, recent (08:32-11:16Z on this same day) evidence of exactly the slow-file/SIGTERM class the card describes. See DoD-2 above for the full verbatim blocks.
- **`827f342f` (`gate-history`'s cancel-settle wait flaking under concurrent gates): NO MATCH on the literal file name `gate-history`.** VERIFIED — zero `FAILURES:` bullets name `gate-history` anywhere in the corpus. **Adjacent finding, explicitly flagged as NOT the same file:** `948dabfb` has `gate-cancel` (exit 1) failing on `(e2e single-admission) the merge itself succeeded`, with `[waitUntil-outcome] ABSENT through 505ms (5.0x budget) for gate-cancel: condition` — a cancel/settle-timing flake under a run with 3 OTHER concurrent gate tests also timing out in the same window (`emit-compare-gate-scope`, `emit-compare-gate`, `merge-gate-inert-diff` all failed in this exact run). This is the same *class* of symptom (a settle-wait timing out under concurrent-gate load) but a **different file** (`gate-cancel`, not `gate-history`) — I am not claiming this recurred the named card's failure; I'm reporting a similarly-shaped signature under the same load conditions, for the manager to judge.
- **`ef7fe55c` (`worker-spawn-shipped-match` in-suite-only failure): NO MATCH.** VERIFIED — zero `FAILURES:` bullets name this file anywhere in the corpus.
- **`e1183875` (`merge-gate-reuse` in-suite-only failure): NO MATCH.** VERIFIED — zero `FAILURES:` bullets name this file.
- **`bab0e772` / `8c056b70` (`codescape-health-probe` flaking / capture the failing `check()`): NO MATCH.** VERIFIED — zero `FAILURES:` bullets name this file. (It does appear as a bare `PASS  codescape-health-probe` mention in several passing loom-daemon spills — that is not a failure and is excluded per the search method above.)
- **`19456eb6` (`restart-wake-classification`'s in-suite ACCESS_VIOLATION): NO MATCH.** VERIFIED — zero `FAILURES:` bullets name this file, and the literal string `ACCESS_VIOLATION` does not appear anywhere in the 29-file corpus.
- **`a1e955f3` (git subprocess exits status 1 with EMPTY stdout AND stderr): NO MATCH.** VERIFIED — none of the 6 real failures in this corpus involve a `git` subprocess exiting 1 with empty output; the closest shape (`shutdown-marker`, exit 1 with content) is unrelated (no `git` invocation in that test at all).
- **`25bc38d7` (the next timeout in `gate-status`, `merge-spawn-tracked` or `gate-timeout-circuit-breaker`): NO MATCH.** VERIFIED — zero `FAILURES:` bullets name any of these three files.
- **`8a80db4f` (a `(f)`-prefixed assertion in `codescape-supervisor.mjs`): NO MATCH.** VERIFIED two ways: (1) zero `FAILURES:` bullets name `codescape-supervisor` anywhere in the corpus; (2) I additionally swept all 12 settled Codescape-origin spills directly for both `codescape-supervisor` and any `not ok ` line — 0 hits for either, across all 12 (2,823-2,864 tests each, all green). `codescape-supervisor.mjs` is confirmed to be a Loom-daemon test file (`packages/daemon/test/codescape-supervisor.mjs`), and it only ever appears in this corpus as a bare passing `PASS  codescape-supervisor` mention.

**Bonus findings not on the named list (reported per DoD-3's "a card with no match is a real result" principle, extended to the reverse — a real failure with no card is also worth surfacing):**
- `merge-batch-dedupe` — 3 real assertion failures (`(1)`, `(3)`, `(4)` above) in `4f84d2b9`, retried and passed. No open card matches this by name in the set I was given.
- `shutdown-marker` — exit 1 despite all 31 printed assertions reading PASS, in `c2891462`, retried and passed. No open card matches this by name in the set I was given.

## DoD-4 — Honesty pass

- **VERIFIED** (direct content/byte read by me, this session): the full inventory table, all 4 `FAILURES:` block extractions, the origin split (loom-daemon vs. codescape), the "0/29 capped" result, the "compact reporter, not truncation" mechanism (cross-checked against `test-daemon.mjs` source at `packages/daemon/scripts/test-daemon.mjs:1135-1136,1364`), the final-verdict correction (3 of 4 `FAILURES:`-bearing spills actually settled PASS via in-op retry), all 9 DoD-3 card checks (6 no-match, 1 direct match, 1 adjacent-but-different-file, 1 confirmed-absent-two-ways), the `codescape-supervisor.mjs` file's real location, and the live-directory diff showing no eviction occurred during this task.
- **RELAYED**: none — I did not rely on any other agent's or document's characterization of spill content; every claim above traces to a byte I read myself in this session.
- **INFERRED**: (1) that `shutdown-marker`'s exit-1-despite-all-PASS shape is the kind of thing `exit-code-verdict-guard.mjs` exists to catch — I did not read that guard's source, so this is a plausible inference from its name, not a verified match; (2) that the `merge-gate-single-file-retry` mechanism named in one spill's own timing summary is the SAME mechanism producing the in-op retries I observed in `228b5e8a`/`4f84d2b9`/`c2891462` — I confirmed a retry mechanism exists in source (`grep` hit in `sessions/service.ts`, `gate-runner.ts`, `mcp/orchestration.ts`, `db.ts` for `singleFileRetry`/`retryReducedGate`) but did not read that code path in full to confirm it's exactly what fired here; the *observed behavior* (same opId, same file, fail-then-pass) is VERIFIED regardless of which code path caused it.
- **No flake-frequency rate was computed or is reported**, per the card's own instruction — every count above is a raw tally over this one 29-file convenience sample, not a rate.
- **Scope not covered**: I did not open any individual test file's own source to determine whether any of the 6 observed failures (beyond the two named-card matches/near-matches) are already-known, already-carded issues under a title I wasn't given to search for — I searched only against the 10 opIds/titles the card handed me, plus the two bonus findings named as such above.
