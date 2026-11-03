# 9d01b4c1 — one shared BOM-split helper for both skill permission-widening paths
From the 712148f1 Code Review round 3 (reviewer 3d46b491, 2026-11-03), carded `9d01b4c1`.
The cwd `.claude/skills` permission scan (`skills/permission-scan.ts`'s `scanCwdSkillsForPermissionFrontmatter`)
called `detectPermissionWidening`/`frontmatterReadIncomplete` directly on the raw bytes `readHead` returns.
`skills/permissionGuard.ts`'s refuse (`permissionWideningRefusalError`) and strip (`stripPermissionWidening`)
paths already split off a leading UTF-8 BOM (U+FEFF) first, via a local `splitLeadingBom` helper, because
every pattern in `permissionWidening.ts` (`FRONTMATTER_OPEN_RE`'s `^---` foremost) is anchored at the
literal start of the string. A BOM-prefixed `hooks:`/`allowed-tools:` (or unrecognized-syntax) skill
therefore produced zero scan findings while the refuse path would have caught the identical content —
a two-path asymmetry, not a both-paths blind spot.
Card 22813c50 (item 5, "N2") separately investigates whether Claude Code's own loader honours a BOM-led
SKILL.md at all — that question stays open and unrelated to this fix. This card closes only the
asymmetry: once a BOM is confirmed present, the scan and the refuse/strip path must agree on it, exactly
as they already must on frontmatter shape and every other detected vector.
## Fix
`splitLeadingBom` (plus the `BOM` constant) moved from `skills/permissionGuard.ts` into
`skills/permissionWidening.ts` — the one module both `permission-scan.ts` and `permissionGuard.ts` already
import from — and is exported from there. `permissionGuard.ts` now imports it instead of defining its own
copy. `scanCwdSkillsForPermissionFrontmatter` calls it on `head.content` before calling
`frontmatterReadIncomplete`/`detectPermissionWidening`, exactly mirroring `stripPermissionWidening`'s own
`splitLeadingBom(content).body` call.
## Round 2 (from the 712148f1 CR round 3's own follow-on, carded `9d01b4c1` round 2)
Round 1 (above) fixed the asymmetry at two call sites (`permission-scan.ts`, `permissionGuard.ts`) by
having each one call `splitLeadingBom` BEFORE handing content to the detector — but left a THIRD
raw-content path unfixed: `permissionWideningField` (`permissionWidening.ts` — the response field shared
by `listSkills()`/`store.ts` and the gateway's single-skill REST read, `GET /api/skills/:name`) calls
`detectPermissionWidening` on content neither of those two callers ever splits. A BOM-prefixed hooks skill
therefore showed no permission badge in the Skills UI even though the cwd scan and the refuse/strip path
both already caught it.

The fix moved the invariant OFF every call site and INTO the shared detector itself: `detectPermissionWidening`,
`frontmatterReadIncomplete`, and `frontmatterUnrecognizedSyntax` (`permissionWidening.ts`) now each call
`splitLeadingBom` internally, first thing, before doing anything else. No caller — today's three, or a
future fourth — can forget to split first, because there is no "first" left for a caller to remember:
the split happens inside the function being called. `permission-scan.ts` and `permissionGuard.ts` still
split BEFORE calling too (round 1's fix, left in place) — redundant now, but harmless, since splitting an
already-BOM-free body is a no-op.

## Do not
- Do not hand-roll a second BOM-split helper at a call site — `permissionWidening.ts`'s `splitLeadingBom`
  is the one shared helper; both `permissionGuard.ts` and `permission-scan.ts` import it.
- Do not add a new raw-content call to `detectPermissionWidening`/`frontmatterReadIncomplete`/
  `frontmatterUnrecognizedSyntax` expecting it to need its OWN pre-split — round 2 made that unnecessary
  by design; a caller may pass either split or unsplit content to any of the three and get the same
  correct answer either way. If you are tempted to "remember to split first" at a new call site, that is
  a sign the split belongs in a fourth shared function instead, not a sign you got this one right.
- Do not read `splitLeadingBom` living in `permissionWidening.ts` as that module now stripping or
  rewriting anything — decision record `87a51903`'s "read-only detector" rule is unchanged; this helper
  only separates a BOM from the body so every existing detector keeps scanning from the real start of the
  frontmatter, it rejects nothing itself.
- Do not treat this fix as settling whether Claude Code's own loader honours a BOM-led frontmatter — that
  is card 22813c50's own open investigation; this card fails closed (scans as if the BOM-led block were
  ordinary frontmatter) regardless of that answer, same posture as the refuse/strip path already took.
