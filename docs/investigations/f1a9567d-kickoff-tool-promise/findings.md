# f1a9567d — kickoff tool-surface promise vs. actual provisioning: findings

Worker investigation, 2026-08-06. **Measurement only, per the card's own hard checkpoint — no production
code was written.** `filesChanged` for this task is this document plus one read-only analysis script
(`scripts/scan-kickoff-mismatch.mjs`) and its output (`scripts/mismatch-hits.json`); nothing under
`packages/` was touched, no Profile/agent/capability was changed.

## The question

Card f1a9567d carried one verified specimen (Loom worker session `b2de9a5b`, 2026-07-09): a manager's
kickoff promised `mcp__codescape__*` tools the worker's resolved Profile never provisioned. Before
building a spawn-time check for this, the card asked for a cheap first measurement: scan kickoffs for
`mcp__<server>__` mentions against each session's actual provisioning, and report how many mismatches
exist — "if the answer is 'just this one, from July,' that is a legitimate outcome and this card may
not be worth building."

## Population and its bound

**1893 directories / 1951 JSONL files** under `~/.claude/projects/C--Users-danie--loom-worktrees-*` on
this host — every Loom **worker** transcript Claude Code currently retains. This is the **full**
currently-retained population, not a sample.

This is **not a calendar window** — Claude Code prunes old transcripts, so "1951 sessions" on its own
says nothing about how far back retention reaches. It reaches back **at least 4 weeks**: the July 9
specimen (`2026-07-09T16:41:28Z`, see below) is still present in this population, which is what turns
1951 into a meaningful denominator rather than an unknown one. Older sessions than that may already be
pruned and are invisible to this method — the true historical mismatch count could be higher than what's
measurable today.

Manager kickoffs (a manager's own spawn) are out of scope — the card's DoD-1 is specifically about
`worker_spawn`, and only worker kickoffs were scanned.

## Method

For each session: take the first real `type:"user"` turn as "the kickoff" (the composed base-brief +
manager-kickoff text, delivered as one `submit()` per CLAUDE.md's kickoff-delivery model — never on
argv). Regex-scan it for `mcp__<server>__`. Compare every mentioned server against that session's own
**provisioned-server set**, derived from the union of `addedNames` across every `deferred_tools_delta`
attachment record in that session's transcript — the same `type:"attachment"` tool-manifest signal the
card's own specimen verification used ("NO type=attachment tool-manifest line" / "sessions that
genuinely carry that surface show the manifest as a single type=attachment record").

Script: `scripts/scan-kickoff-mismatch.mjs`. Re-run it any time this needs re-measuring — it only reads
`~/.claude/projects`, no daemon/DB access, no writes outside its own output file.

## Controls

- **Positive control (does the check fire on a known-bad case?):** yes — it independently re-found the
  July 9 specimen (below). The instrument is not silently returning zero.
- **Negative control (does it stay silent on a known-good case?):** yes — spot-checked 3 sessions with
  `deferred_tools_delta` records that genuinely include `mcp__codescape__*` tool names (confirmed by
  direct grep on the raw JSONL line, not a cross-file confound) and mention codescape in their kickoff;
  none of the 3 appear in the mismatch output.

## Raw result

40 of 1951 kickoffs mention any `mcp__<server>__` server at all. **15 of those name a server not in
that session's own provisioned set** (the raw hit count a naive `mcp__<server>__` substring scan would
report as "mismatches").

## Reading all 15 by hand

None of the 15 are the grammatical-negation case the card explicitly warned about ("no codescape tools,
just normal Read/Grep/Glob navigation"). A dedicated grep for that exact specimen phrase across the
whole population returns **7 files** — every one of them is a session whose kickoff quotes **this card's
own body** (investigating this same defect, or a related measurement task), never an organic manager
telling a worker it lacks a surface. **Zero organic negation occurrences.** This is worth stating as a
measurement, not an absence: the grep is a good instrument, correctly returning non-zero on a real
(meta) match, and still correctly finding no independent case in the wild.

The actual false-positive mode in this corpus is different from what the card predicted:

- **14 of 15** mention the tool-name string as the **subject of a dev task** — writing the literal name
  into an allow/disallow list (`PLAYWRIGHT_DISALLOWED_TOOLS`, `CODESCAPE_WRITE_TOOLS`), building an
  MCP-integration feature (`deja`, `github`) that will expose that name once shipped, or reporting a bug
  in a tool by name (`mcp__loom-audit__transcript_read`) — never a claim about the **current** session's
  own capabilities. A representative sample (full snippets in `scripts/mismatch-hits.json`):
  - `codescape` (×4), `deja` (×2), `playwright` (×3), `github` (×2), `loom-audit` (×1) — 12 of these are
    workers on THIS project building or reviewing spawn/allowlist code that references the string; the
    other 2 (`codescape` ×2 more) are workers on an unrelated measurement card discussing a
    `grep -c mcp__codescape__` counting methodology (an instrument-hazard writeup, not a capability
    claim).
- **1 of 15** is a genuine mismatch, and it is the **same July 9 specimen already on the card**,
  independently re-derived: worktree `.loom-worktrees\c36e8691-44d8-44ae-91ed-1bae3c632b33\fcfb879f477e`,
  engine session `9ff9c1b0-5eb9-4cfd-b895-d746fd583601`, kickoff text verbatim `"Note: you'll have
  \`mcp__codescape__*\` code-map tools — use them naturally to navigate; flag me if they error."`,
  transcript timestamp `2026-07-09T16:41:28Z` (card states `:26Z` — 2s of hook-relay lag), same project.
  **Not a new instance.**

**n = 1 across the full retained population.** Consistent with the card's own stated "not worth
building" bar.

## Design finding, kept for whenever this is re-opened

The card frames negation as *the* discriminator ("the discriminator is NEGATION, not vocabulary — no
better regex closes it"). This measurement refutes that as the dominant failure mode: negation never
occurred organically, so negation-parsing would have cost real engineering effort and caught nothing
that actually happens in this corpus — while still missing all 14 real false positives, which are a
different shape entirely (subject-of-a-task, not negated-claim).

The card's own option (c) — fire only when the kickoff instructs **use** (`use them`, `call`, `you'll
have`) **and** the server is unprovisioned — does much better on this corpus: gating the 15 raw hits on
a use-instruction verb near the mention drops them to **2**: the one real specimen, plus exactly one
false positive (a report that quotes the specimen's own wording, `"you'll have ... use them naturally to
navigate"`, verbatim, while analyzing it). That residual is worth naming precisely: even the best cheap
discriminator observed here still fires on the **act of investigating the defect**, because quoting a
promise and making one are lexically identical. A verb-gated check is far stronger than negation-parsing
for this corpus, but it is not free of false positives either.

## Outcome

Per direction: **not building.** Against n=1 (a 4-week-old, already-known specimen with zero recurrence
across the full retained population), even the best discriminator measured here leaves a ~50%
false-positive rate on a spawn-time notice, with the residual false positive being the investigation of
the defect itself. That is not a defensible cost for the demonstrated benefit. This document exists so
the measurement survives past this worktree — re-run `scripts/scan-kickoff-mismatch.mjs` if a future
session needs to ask "is this still n=1?"
