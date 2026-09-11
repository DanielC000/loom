# 237aa3a9 — failing gate rows get their own failureDetail field, on the per-file flush, so a red is diagnosable from one read

## Narrative

Filed by the Loom lead after spending ~45 minutes and one extra full gate lane hypothesising about a red whose cause the harness could have written to disk at the moment it happened. On a failure, the `kind:"file"` NDJSON row recorded only `ok:false`/`status:1` and nothing about why — no message, no failing assertion, no stack, no captured output — and the daemon's own output log doesn't cover it either (measured: `grep -ac "PASS  (Q)" daemon-output.log` → 0, against a positive control `grep -ac "merge-gate-reuse" daemon-output.log` → 3). The per-scenario pass/fail block survives only in the child's stdout, which reaches the merge nudge as a bounded, content-selected `outputTail` — truncated exactly when a run has many failures, i.e. precisely when it's needed most.

**The incident that made this concrete (card `e1183875`):** gate `dc881772` rejected on `merge-gate-reuse` with "5 FAILURE(S)"; the captured tail cut off mid-scenario, a dispatched diagnosis worker could reconstruct only 4 of the 5 failures from source, and the lead burned an extra forced re-run (`7a08d321`, ~15 minutes of a shared, capped lane) partly to get another look. A single `failureDetail` field on that row would have replaced all of it. This card does **not** retroactively fix `e1183875` — that red's output is already gone; it is about the next one.

**The peer's specimen (Codescape's `failureRecords`)** is what proved the design worth building: their harness's failure entries include a `message`/stack/`failureType` that once named a root cause (a TOCTOU race) outright. Their own words: *"I had a named rival, a co-admission stamp, and a CPU curve — a rich, plausible, entirely wrong account — while the answer sat in a file my own gate writes on every run."* The `failureRecords` design and that lesson are theirs; the Loom-side gap measurement is the lead's own.

**Three design inputs volunteered by the peer, pre-build, changed the shape of the DoD:**

1. **A dead run leaves nothing** — Codescape's own `failureRecords` writes only at a run's *close*, so a total harness death (SIGKILL/timeout/OOM) yields only a bare write-ahead marker, still an open problem on their board (`f244eae8`). Loom already has the identical failure mode one layer down (card `05056168`) — the fix here is the same one: attach `failureDetail` to the **same per-file flush** `runLane` already performs the moment each file completes, not a close-time/summary pass, so it inherits `05056168`'s SIGKILL-survival property rather than reopening the hole it closed. A run killed mid-file still loses that file's detail — an accepted, stated residue, not a silently reintroduced gap.
2. **`failureType` as a first-class field** — a bare message forces every reader to parse prose; a type (at minimum: assertion failed / test code threw / timeout-kill / nonzero exit with no parsed cause) lets a reader route in one glance. Four buckets beat twelve; an honest "unclassified" bucket beats a wrong label. This is the half of the peer's own `failureRecords` design that demonstrably worked in practice — it routed them to a race hypothesis rather than a regression one before they even read a stack.
3. **Presence of a key is not the state it names** — the peer nearly declared a hypothesis refuted because 396 of 898 rows carried a `closed` *key*, which a key-shape census reads as "closed," when the *value* was `false` for all of them. `failureDetail` must therefore be absent-or-valued unambiguously (`JSON.stringify` drops an `undefined` property entirely, so a passing row has no key at all — presence of the key IS the failure signal), and any positive control must assert on values, never on key presence.

**Additive-only, unconditionally:** `failureDetail` is a new key; no existing key on the row is renamed or re-meant (card `f8b176f7` DoD-4's concatenability requirement with the committed investigation snapshot; card `1ec2e353`'s frozen-key convention — the on-disk key is frozen, units are disclosed at the surfaced/typed layer, never on the persisted row).

## Do not

- Do not widen the merge nudge's `outputTail` as a substitute — that is a different surface with its own content-selection logic; this card is about the durable NDJSON record.
- Do not rename or re-mean any existing key on the `kind:"file"` row when adding `failureDetail` — additive only.
- Do not attach `failureDetail` at run-close instead of the per-file flush — that reopens the exact SIGKILL hole `05056168` closed one layer down.
- Do not close card `e1183875` on the strength of this shipping — this instruments the *next* red, not the one already gone.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, module-header decision-history block (originally lines 105-119), as of this tranche's HEAD. Card `237aa3a9`, filed 2026-08-28; incident `e1183875`; peer design inputs from Codescape (their `a1c823f4`/`f244eae8`). Sibling family: `8fb09f4c`, `2db8a3dd`, `60b26261` §PAIR B — the daemon computing or holding a diagnostic and not handing it to the reader who needs it.

Design input 2's closing sentence (tranche 6, DoD-4 restoration) is from the inline comment originally at
lines 1106-1132, preceding `classifyFailureDetail` — see `cad5d5d6`'s own record for that site's CR follow-up.
