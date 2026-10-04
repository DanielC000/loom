# 35099271 — stamp "human" AFTER the content write, never before

## Narrative

From the delta Code Review of `9a3dea30` (reviewer `b977b7df`, item 1): `resetSkillToBundled` and
`adoptSkillUpdate` each called `clearSkillProvenance(name)` after landing bundled content, but ignored its
boolean return. If that clear failed, the genuine copy kept a stale `"agent"` stamp, and the NEXT boot's
`renameAsideAgentCollision` would wrongly rename the genuine, just-reset-or-adopted copy aside and reseed
pristine content under `name` — for `adoptSkillUpdate`, silently discarding a human's just-adopted merge
resolution.

The fix stamps `"human"` instead of clearing (`stampSkillProvenanceHuman`, `skills/store.ts`) on the two
genuine human-REST paths (`/api/skills/:name/reset`, `/api/skills/:name/adopt`) and the human-REST publish
route (`/api/skills/:name/publish`) — a human actually vouched for this content on all three paths, so
`"human"` is the accurate, positive claim, not merely "not agent". The Lead's agent-driven `skill_write`
(`skillTools.ts`, `allowBundledAsset:true`) keeps `clearSkillProvenance` — an agent actor is never entitled
to a `"human"` stamp — but now surfaces a failed clear as an error instead of silently proceeding.

## Ordering is load-bearing: write content, THEN stamp

`adoptSkillUpdate` writes the resolved content (`writeSkill` + `writeBase`) BEFORE calling
`stampSkillProvenanceHuman`. `resetSkillToBundled` likewise discards+restores the directory
(`rmSync`+`cpSync`) before stamping. This ordering is deliberate, not incidental:

- If the stamp were written FIRST and the content write then failed, the store would be left with a
  `"human"` stamp over content that was never actually written by this call — i.e. over whatever content
  happened to be on disk already, which could be an unresolved agent-written collision. That silently
  upgrades untrusted content to trusted the moment the stamp lands, with no guarantee the content it's
  vouching for is the content the human actually approved.
- With content-then-stamp, the worst case of a failed stamp is the reverse and strictly safer: the content
  IS what the human approved, but the provenance ledger hasn't caught up yet. The content itself is never
  wrong; only the bookkeeping about it lags.

Both failure cases are already visible to their caller: `resetSkillToBundled`/`adoptSkillUpdate` surface a
stamp failure as its own distinct outcome (see "REST outcome shape" below), never folded into an unrelated
"no bundled version" response — the content HAS already landed by the time the stamp is attempted, so the
human must be told the content succeeded but the provenance record didn't, not that nothing happened.

## REST outcome shape

Both `resetSkillToBundled` and `adoptSkillUpdate` widen their return type to carry a THIRD, distinct
outcome for "content landed, stamp failed" — `{ error: "provenance-stamp-failed" }` for `adoptSkillUpdate`
(alongside its existing `{name,content} | null`), and a non-boolean truthy sentinel for
`resetSkillToBundled` (alongside its existing `boolean`). Neither touches the existing success/the
`null`/`false` not-bundled shapes, so no existing caller or test (which only assert the success case, or
never exercise this branch) needed to change. Each REST route checks for this distinct shape and responds
`500` with a message that names the provenance-stamp failure and tells the caller to retry — never the
generic `404 "no bundled version for this skill"`, which would misdirect a human whose content-write
genuinely succeeded.

## Round 2 — writeBase must also follow the stamp, not just precede it (Code Review 2b5d5216 of b07894f1)

`adoptSkillUpdate` had content → `writeBase` → stamp: `writeBase(name, v.shipped)` runs BEFORE
`stampSkillProvenanceHuman`, so a failed stamp still leaves `updateAvailable` cleared (base==shipped). The
REST route (`POST /api/skills/:name/adopt`) refuses with 409 "no update available" whenever
`skillUpdateAvailable` reads false — so the documented "retry to re-stamp it" advice on a stamp failure was
false: the retry would 409 before ever reaching `adoptSkillUpdate` again, and the genuinely-adopted content
is left exposed under a stale `"agent"` stamp with no REST-reachable way to re-stamp it. The NEXT boot's
`renameAsideAgentCollision` (`9a3dea30`) then renames that genuine, human-adopted copy aside as an
unresolved agent collision — permanently, since that function never re-reads a once-renamed name.

Fixed by reordering to content → stamp → `writeBase`: `writeBase` (the call that clears
`updateAvailable`) now runs only AFTER the stamp has already succeeded. A failed stamp leaves
`updateAvailable` still true, so a retry re-enters `adoptSkillUpdate` from the top — re-writing the same
content (idempotent) and re-attempting the stamp — exactly matching the REST route's own advice.
`resetSkillToBundled` already had this order correct (stamp before its own `writeBase` call); only
`adoptSkillUpdate` needed the fix. Proved via `app.inject` against the real REST routes: force the stamp to
fail ⇒ 500 with `updateAvailable` still true; clear the forced failure ⇒ retry ⇒ 200 with the content
re-applied and a `"human"` stamp. Same REST-level RED/GREEN added for `/reset` (which was already correctly
ordered, so this is coverage, not a behavior change there).

## Do not

- Do not call `stampSkillProvenanceHuman` before the content write it is meant to vouch for — see
  "Ordering is load-bearing" above.
- Do not fold a stamp failure into the same `404`/null-return path used for "not a bundled skill" — they
  are different failures (nothing happened vs. the content DID land) and deserve different REST responses.
- Do not use `stampSkillProvenanceHuman` from an agent-driven write path (e.g. the Lead's `skill_write`) —
  only `clearSkillProvenance` there; an agent actor must never be marked human-vouched.
- Do not let any write that clears `updateAvailable` (e.g. `writeBase(name, shipped)`) run BEFORE the
  stamp in a human-REST adopt/reset path — see "Round 2" above: a failed stamp must leave the update still
  retryable, never silently cleared out from under it.

## Source

`packages/daemon/src/skills/store.ts` (`stampSkillProvenanceHuman`, `adoptSkillUpdate`,
`resetSkillToBundled`), `packages/daemon/src/mcp/skillTools.ts` (`skillWriteData`'s bundled-asset branch),
`packages/daemon/src/gateway/server.ts` (`/api/skills/:name/reset`, `/adopt`, `/publish`).
