# 8449a258 — decision-record truncation is structural: protect "Do not", truncate only narrative

## Narrative

Card `09029e98` found `packages/daemon/assets/decision-records.mjs` has two byte caps: `PER_RECORD_MAX_BYTES` (6000, per record) and `TOTAL_MAX_BYTES` (12000, per `Read` call — the binding one, since it drops further WHOLE records once exceeded). A follow-up specimen on record `088afc94` (9,371 B on disk) showed the existing positional head+tail truncation silently eliding that record's SECOND `## Do not` section — a real prohibition, dark on every injection — while the first and third `## Do not` sections (head and tail) stayed visible, so a reader checking "are the Do-nots there?" saw no cue anything was missing.

Owner request `a0155873` offered four options; the owner chose (b): make truncation STRUCTURAL — always inject the record's title and every `Do not`-style section in full, and truncate only the rest — with an explicit "no cap raised."

**Population measured (sha `ce34994b152eba754c306ba2593425ff11c2704a`):** 905 records are reachable via `resolveRecord` (9 `docs/adr`, 859 `docs/decisions`, 37 `docs/investigations/*/findings.md`). Matching a `Do not`-style heading at ANY level (`#`–`######`, case-insensitive): 835 (92%) carry at least one; 70 (8%) carry none and use the fallback. Critically, matching ONLY `##`-level headings undercounts this: 18 of those 905 records carry their `Do not` section exclusively at `###`, nested under a `##` parent (e.g. `## Decision A` / `### Do not`). The implementation therefore splits on every heading level, not just `##` — the card's own warning ("convention, not schema") is measurably true. Max protected-content size (title/preamble + all Do-not sections) found across the whole corpus: 2,491 B, well under the 6,000-byte cap, so the "protected content alone exceeds the cap" degenerate case is unreached today.

**Fixture RED/GREEN** (docs `088afc94`, isolated via a narrow `Read` — `packages/daemon/src/pty/host.ts` offset 1460/limit 20, the only anchor site for this id in that window): pre-fix, the injected context omits `## Do not (2)` and its content entirely, no elision-scope cue. Post-fix, `## Do not (2)` and its first content line are both present in full, with a `TRUNCATED` note naming the new structural mode.

**DoD-4 re-measurement** (`packages/daemon/src/sessions/service.ts`, default whole-file `Read`, sha `ce34994b152eba754c306ba2593425ff11c2704a`): 5 records fit / 40 omitted whole — IDENTICAL before and after this change. None of the 5 fitting records needed per-record truncation at all (all under 6,000 B individually); the binding constraint at this anchor site is `TOTAL_MAX_BYTES` exhaustion by several small, already-under-cap records; whole-record dropping, not per-record truncation. So this change does not, by itself, increase records-per-anchor-site density — see "Do not" below.

## Do not

- Do not raise `PER_RECORD_MAX_BYTES` or `TOTAL_MAX_BYTES` to address this — the owner's answer to request `a0155873` was explicit ("no cap raised"); the fix is WHICH bytes survive truncation, not how many.
- Do not detect the protected section by matching only `##`-level headings — 18 real records in this corpus carry their `Do not` heading only at `###`, nested under a `##` parent; split on every heading level (1–6) instead.
- Do not assume this change increases how many records fit at a shared anchor site — a record already under `PER_RECORD_MAX_BYTES` renders the same size whether or not it has a `Do not` section, so `TOTAL_MAX_BYTES` still drops whole records exactly as before when the binding pressure is total-budget exhaustion by several small records (see the `sessions/service.ts` re-measurement above). This change protects a TRUNCATED record's own prohibitions from disappearing; it is not a density fix.

## Source

`packages/daemon/assets/decision-records.mjs`: `splitIntoBlocks`, `isDoNotHeading`, `headTailSlice`, `legacyHeadTailTruncate`. Card `8449a258`, request `a0155873`. Population and re-measurement figures above are pinned to sha `ce34994b152eba754c306ba2593425ff11c2704a`.

**Note (card `abd049da`):** the protected-content rule this decision established (title + every 'Do not' heading survives in full) is now enforced by `extractDoNotOnly`, not `truncateRecord` — `truncateRecord` (which used to compute a "protected vs. other" split and truncate only the "other" half) was deleted once the injector stopped injecting the narrative at all, leaving no "other" half to truncate. This decision is NOT superseded: `abd049da` enforces it more strongly than before (the narrative can no longer even land in an elided middle, since it is never injected in the first place).
