# 31613c1e — LEAD RULING: transcript-root deny splits BLANKET (manager/platform/setup) vs PROJECT-SCOPED (worker), rejecting the one-knob alternative

## Narrative

Card `d78f8217` (implementing `31613c1e`'s LEAD RULING, the approved split, option (d)): `manager`/`platform`/`setup` join the BLANKET `TRANSCRIPT_ROOT_DENY_ROLES` set — the reviewer swept `packages/daemon/assets/**` + `.claude/skills/**` for `.claude/projects` and found ZERO hits (positive-controlled: the same pattern returns 10 hits under `src/`+`test/`), so nothing shipped depends on any of these three roles reading the transcript root natively.

`worker` is DELIBERATELY NOT added to the blanket set — a worker legitimately reads its OWN project's transcripts (six in-tree investigations depend on it), so the blanket rule would regress shipped behavior. It instead gets a PROJECT-SCOPED deny via the `workerProjectDenyRules` param on `withTranscriptRootDenyForSpawn` — see `otherProjectTranscriptDenyRules`'s own doc (`claude-transcript.ts`, card `d78f8217`'s own record) for the two rule shapes and why both are needed.

31613c1e's LEAD RULING rejected the one-knob "blanket for all four" alternative — applying the same blanket deny to `worker` too, rather than a project-scoped carve-out — as weaker exactly where exposure is highest: `platform` holds git push + `vault_write` alongside cross-project `session_transcript`, so under-restricting THAT role in exchange for a simpler single knob was judged the wrong trade. The chosen split costs more code (two rule shapes, a DB-derived per-project list for `worker`) but keeps every role's exposure proportional to what it can already reach through other means.

The ruling also carries an explicit, load-bearing caveat about the mechanism's own limit: this is a DENY-LIST over a DB-derived set and so FAILS OPEN on anything not enumerated — most notably a non-Loom `claude` session's transcripts elsewhere on the host. Best-effort narrowing, NEVER a structural guarantee.

## Do not

- Do not collapse the blanket/project-scoped split back into a single one-knob rule for all four roles (manager/platform/setup + worker) — the split was a deliberate LEAD RULING, rejecting that exact simplification as weaker where exposure is highest (`platform`'s git push + `vault_write` + cross-project `session_transcript`).
- Do not describe this mechanism's guarantee more strongly than it is. Carry the ruling's own sentence verbatim wherever this decision is cited: "CARRY ITS LIMIT VERBATIM OR THIS BECOMES THE NEXT OVERCLAIMED CONTAINMENT DOC" — it is a best-effort DENY-LIST over a DB-derived set, fails open on anything not enumerated (e.g. a non-Loom `claude` session's transcripts elsewhere on the host), never a structural guarantee.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (above `TRANSCRIPT_ROOT_DENY_ROLES`, the `d78f8217`/`31613c1e` paragraph), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`) — this is the designated home for `31613c1e`'s fuller ruling content, left unrecorded by the `claude-transcript.ts` tranche that produced `docs/decisions/d78f8217-worker-per-other-project-transcript-deny.md` (see that record's own `Source` note). Wording unchanged beyond joining wrapped lines and stripping `*`/`{@link}` markup.
