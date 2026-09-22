# 72249ae0 — an auditor's `end_me` carries an optional `scanReport`; its ABSENCE, not its presence, is the coverage-integrity signal

## Narrative

Filed from the Code Reviewer's second follow-up on `cea3cec6` (card `b1960b04`): an auditor's `end_me`
can be driven by the very transcript content it is auditing (prompt injection is in scope for this role
by construction — it reads attacker-influenceable content, unattended, with no per-call approval), and a
truncated scan pass left **no trace** that it was truncated. The row just landed on Archive looking
exactly like a genuinely completed pass.

`end_me` (both `mcp/audit.ts` and `mcp/user-audit.ts`, canonical implementation
`SessionService.endMe`, `sessions/service.ts`) now takes an optional `scanReport: string` — a short
summary of what the pass covered, meant to be the auditor's normal last tool call before ending. The
fix is deliberately **not** a self-declared completion flag (`complete: true`): a hijacked call could
assert that boolean exactly as easily as a real one, so presence of a claim proves nothing. What the fix
actually reads is **absence**: a bare `end_me()` call — the exact shape the card's adversary model
describes an injection driving — carries no `scanReport` at all, and that omission is what a genuinely
compromised early-exit would produce and never think to fill in on its own.

On the success path of `endMe`, for `role === "auditor" | "workspace-auditor"` only, a missing
`scanReport` triggers `fileMissingScanReport`: a **best-effort**, **system-authored** (not agent-called)
low-severity finding filed through the exact same write path a real finding already uses —
`auditFileFinding` (Platform backlog) for the dev Auditor, `workspaceAuditSuggest` (the user's own
reserved home) for the Workspace Auditor. This reuses an **already-established reader** — the
platform-lead skill is taught to triage "Auditor-filed findings sitting in the backlog"
(`platform-lead/SKILL.md:159`) — rather than inventing a new surface nobody currently watches. The
filed finding's own text explicitly says this is a signal, not proof: a legitimate session that
predates this doctrine step, or simply forgot it, is indistinguishable from a truncated one by this
mechanism alone: a human still reads the transcript before treating it as a real incident.

Both `platform-audit/SKILL.md` and `workspace-audit/SKILL.md` were updated in the same change to teach
`scanReport` as the normal final step before `end_me` — without that doctrine update, every legitimate
pass would still call bare `end_me()` and the daemon would auto-file a finding on every clean run,
turning the mechanism into noise within days. `workspace-audit/SKILL.md` ships to end users (it is
**not** in `DEV_ONLY_SKILLS`, `scripts/curate-release-skills.mjs`) and stays fully generic — no
Loom-internal paths, package names, or card ids; `platform-audit/SKILL.md` is dev-only and may
reference Loom internals freely.

## Documented ceiling — read this before trusting the signal as more than it is

This is a **coverage-integrity** signal, not an adversarially-hardened control. The reviewer's own
bounding of the hole applies here too: the auditor's ceiling is a daemon-local, human-reviewed board
card with no outward channel, and this fix does not change that. A caller sophisticated enough to have
read this exact mechanism (Loom's source is public) could emit a fabricated `scanReport` alongside a
truly-truncated `end_me` and defeat the signal entirely — nothing here proves non-repudiation. The bar
this closes is "zero signal today" → "a signal an unmodified/naive injected `end_me` call won't
produce," not "a signal no adversary could ever produce." Do not cite this mechanism as proof a given
scan pass was genuinely complete; it is only ever evidence that a pass at least reached its own normal
final step.

## Do not

- Do not turn `scanReport` into a boolean or any other self-declared "I finished" claim — its ABSENCE is
  the signal, precisely because an injected call can assert a claim exactly as easily as a real one.
- Do not gate or weaken `end_me` on this field. It stays fully optional and the stop always proceeds;
  `fileMissingScanReport` is called on the already-successful path, never blocking it, and is
  best-effort (wrapped so it can never throw into the caller).
- Do not read a filed "ended without a scan-completion report" finding as proof of a truncated pass — a
  legitimate session that predates or skips the doctrine step looks identical. A human checks the
  transcript before treating it as a real incident.
- Do not let `workspace-audit/SKILL.md`'s teaching of this drift from generic — it ships to end users;
  keep Loom-internal specifics (paths, package names, card ids) in `platform-audit/SKILL.md` only.
- Do not treat this as closing the hole for a session that never calls `end_me` at all (a crash or an
  external stop) — that is a different, arguably worse truncation shape, explicitly out of scope for
  this card (carded separately by the filer).

## Source

`packages/daemon/src/sessions/service.ts` — `SessionService.endMe` (the `@decision 72249ae0` anchor on
its JSDoc) and `fileMissingScanReport` (its own `@decision 72249ae0` anchor), immediately below `endMe`.
`packages/daemon/src/mcp/audit.ts` and `packages/daemon/src/mcp/user-audit.ts` — each `end_me`
registration carries its own `@decision 72249ae0` anchor at the schema. Doctrine:
`packages/daemon/assets/skills/platform-audit/SKILL.md` and
`packages/daemon/assets/skills/workspace-audit/SKILL.md` ("End of a scan pass" sections). Test:
`packages/daemon/test/end-me-scan-report.mjs`.
