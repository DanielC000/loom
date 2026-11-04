# 51a2462a — refuse an agent-written skill's permission-widening content at write, strip it at injection

From the background report `research/skill-frontmatter-permission-widening-2026-11-02.md` (card
`28b2ca6f`). Decision record `87a51903` made `skills/permissionWidening.ts` a read-only detector and
explicitly carved the agent-skill refuse/strip out of its own scope ("a different concern that belongs
on the write path... and must not be bolted onto this module"). This card is that different concern.

## What this card does

1. **Refuse at write** (`permissionWideningRefusalError`, new `skills/permissionGuard.ts`) — called at
   the START of `skillWriteData` (`mcp/skillTools.ts`), before the bundled/user branch split, so it
   covers BOTH branches: the ordinary user-store write AND the dev-only Lead's bundled-asset-edit
   branch. Every `skillWriteData` call is agent-authored by construction (there is no human-REST path
   through this function — the human Skills UI/REST calls `writeSkill`/`adoptSkillUpdate` in
   `store.ts` directly), so the check has nothing to carve an exception for. Fires for `skill_write` AND
   `skill_edit` alike, since `skillEditData` delegates its actual write to `skillWriteData`.
2. **Strip at injection** (`stripPermissionWidening`, same module) — `skills/inject.ts`'s copy loop
   calls this for every delivered name that is NOT human-provenance-stamped and is NOT a bundled asset
   whose store copy is still content-equal (normalizeForCompare-tolerant) to the shipped asset (round 2 —
   see below; round 1's bare `isBundledSkill` exemption was too wide). Agent-stamped, unstamped, and now a DIVERGED bundled name
   all fail closed, the same posture decision record `509176c8` uses for locked-role delivery. Defense in
   depth: the write-time refuse above only covers content written AFTER this card ships; an older row,
   or content that reached the store out of band (a direct filesystem write, a restored backup), is
   still caught here on every delivery.
3. **BOM fail-closed** — both functions split off a leading UTF-8 BOM (U+FEFF) before scanning, so a
   BOM-led frontmatter block is treated as frontmatter rather than invisible to `FRONTMATTER_RE`'s
   literal-start anchor. Card `22813c50` separately investigates whether Claude Code's own loader
   honours a BOM-led block at all; this card does not wait on that answer — refuse/strip fail closed
   either way.

## Why a separate module, not `permissionWidening.ts`

Decision record `87a51903`'s "Do not" is explicit: that module stays a read-only detector, and a
refuse/strip concern must live elsewhere. `skills/permissionGuard.ts` is that elsewhere. It does not
duplicate `permissionWidening.ts`'s patterns — it imports `FRONTMATTER_RE`, a newly-extracted
`FRONTMATTER_KEY_LINE_RE` (pulled out of `topLevelFrontmatterKeys`'s own inline literal, zero behavior
change), `INLINE_SHELL_RE`, and `FENCED_SHELL_RE`, all now `export`ed from `permissionWidening.ts`
additively (no reject/strip logic added to that file itself — only its existing private patterns made
public so a sibling module can reuse rather than copy them, per that record's "do not copy these
regexes into a second file" bullet).

## What "strip" actually removes

- **Frontmatter `allowed-tools`/`hooks`** — the top-level key line AND every following line up to (not
  including) the next top-level key line or the closing `---`, i.e. the whole YAML node under that key
  (a bounded line scan over the ONE block `FRONTMATTER_RE` matches, mirroring
  `topLevelFrontmatterKeys`'s own column-0 key boundary — never a full YAML parse). Every other field,
  and its own exact line text and order, is reproduced byte-for-byte. An inline flow value
  (`allowed-tools: [Bash, Read]`) is removed with its one line; a multi-line `hooks:` block is removed
  down to (not past) the next top-level key.
- **Body `` !`cmd` `` / ` ```! `** — only the TRIGGER character is dropped: the leading `!` of an inline
  `` !`cmd` `` (leaving an inert `` `cmd` `` code span) and the trailing `!` of a fenced ` ```! ` opener
  (leaving an ordinary ` ``` ` fence). The command text itself stays visible for review; nothing is
  deleted wholesale. Round 2: a SINGLE pass over this step can MANUFACTURE a fresh trigger out of a
  doubled one (`` !!`cmd` `` strips to the still-flagged `` !`cmd` ``; ` ```!! ` strips to the
  still-flagged ` ```! `) — see "Round 2" below for the fix.
- The file's own line-ending style (CRLF vs LF) is preserved for the rebuilt frontmatter block; nothing
  outside the matched frontmatter block (or outside a matched shell construct) is touched at all.
- A clean skill's `stripPermissionWidening(content) === content` (same reference) — the strip never
  rewrites, and `inject.ts`'s `stripPermissionWideningFile` never even opens a write, for content that
  was never flagged.

## Closure property

`detectPermissionWidening(stripPermissionWidening(x))` is always `[]` OR `stripPermissionWidening(x)` is
`null` (round 2 — a failed-closed signal, never a partially-stripped string). When non-null,
`stripPermissionWidening` is idempotent (`strip(strip(x)) === strip(x)`) — both follow from detect and
strip sharing the SAME pattern set (`permissionWidening.ts`'s own exports) rather than a second copy that
could disagree about what still counts as a vector after a strip. To actually REACH closure rather than
merely claim it, `stripPermissionWidening` loops its frontmatter/shell-trigger passes to a fixpoint
(bounded by `STRIP_FIXPOINT_MAX_PASSES`) instead of running once — see "Round 2" below.

## Round 2 — fail-closed strip failure, fixpoint closure, content-equality bundled exemption

A Code Review of round 1 found the REFUSE layer sound but the STRIP layer unsound in three ways, all
fixed in the same pass (worker round, no new card):

1. **The strip used to fail OPEN.** `stripPermissionWideningFile` (`inject.ts`) ran AFTER
   `copySkillAtomic` had already placed the full, unstripped store copy at `dest` and after `dest`'s name
   was pushed onto `placed` — a write failure (all 3 tmp+rename attempts failing, or an unreadable
   SKILL.md past `ENOENT`) only LOGGED; the hazard stayed delivered at `dest`, `placed` still named it,
   and it was still fingerprinted as Loom's own trusted placement. Fixed: `stripPermissionWideningFile`
   now returns `boolean` (success/failure, with `ENOENT` — nothing to strip — reading as success); its
   caller in `inject.ts`'s copy loop, on `false`, removes `dest` entirely, pushes the name onto `failed`
   (the SAME path a copy failure already used, which `injectSkills` already surfaces via a thrown
   `Error` naming every failed name), and skips the fingerprint/`placed` entry — never partially delivers.
2. **A single strip pass was not a fixpoint.** `stripShellTriggers` (`permissionGuard.ts`) MANUFACTURED a
   fresh canonical trigger out of a doubled or tripled one instead of removing it (see "What strip
   actually removes" above). Fixed two ways, together: (a) `stripPermissionWidening` now loops
   `stripFrontmatterKeys`+`stripShellTriggers` to a fixpoint, bounded by `STRIP_FIXPOINT_MAX_PASSES`; (b)
   a fail-closed POSTCONDITION — if `detectPermissionWidening` of the fixpoint result is still non-empty
   (the bound was hit before closure), `stripPermissionWidening` returns `null` rather than a
   partially-stripped string, and `stripPermissionWideningFile` treats `null` exactly like a write
   failure (item 1) — the skill is withheld entirely, never delivered half-stripped.
3. **The bundled-name exemption was provenance-free.** `needsPermissionStrip` used to exempt ANY
   `isBundledSkill(name)` unconditionally — but "reviewed at merge" only ever covers the shipped ASSET,
   never a direct, out-of-band filesystem write to `<SKILLS_DIR>/<bundled-name>/SKILL.md` that bypasses
   both the Skills UI and `skillWriteData`'s own write-time refuse. Fixed: a bundled name is now exempt
   only when its STORE copy is content-equal (`isPristineBundledContent`, `store.ts` — the same
   `normalizeForCompare`-tolerant asset-vs-store comparison `customizationState` already uses, never a second
   hash) to the CURRENT shipped asset, OR its provenance is `"human"`. A diverged, non-human bundled-name
   store copy is now treated exactly like any other agent/unstamped skill. Deliberately NOT
   `customized:false` — that compares against the last-synced `base` snapshot, which an out-of-band write
   never touches and which can itself be stale independent of the real shipped asset.

## Round 3 — fail-safe dest cleanup, whole-run strip, fail-closed postcondition coverage

A Code Review of round 2 judged the round sound overall but found one blocking gap and two further
issues, all fixed in the same pass (worker round, no new card):

1. **MAJOR — the fail-closed `null` postcondition was untested.** `permissionGuard.ts`'s
   `stripPermissionWidening` returns `null` when the fixpoint result still detects as widening (see
   "Closure property" above) — but no test exercised that branch at all; a reviewer confirmed this by
   deleting the `return null` line in the compiled output and watching every existing test stay green.
   Two new tests close this:
   - `skill-permission-guard.mjs` PART D' — a **deliberately injected detector**, not a crafted real
     fixture. Once this round's whole-run strip (item 3 below) ships, there is no longer a real
     combination of the four known vectors that survives a single fixpoint pass, so a 20×`!` stress
     fixture would simply strip clean — it would prove nothing about the `null` branch. Instead, the test
     builds a throwaway copy of `permissionGuard.js` that imports a throwaway `permissionWidening.js`
     whose `detectPermissionWidening` is forced to ALWAYS report non-empty, then calls the real
     (unmodified) `stripPermissionWidening`/fixpoint/postcondition logic against that forced-always-dirty
     signal and asserts the result is `=== null` for arbitrary input, including already-clean content.
     This isolates "does the postcondition actually return `null` when detection-after-strip says
     non-empty" from "can real content ever make detection-after-strip say non-empty" — the latter is, by
     design, now unreachable through the four known vectors.
   - `skills-inject-permission-strip.mjs` (l) — the inject-level twin: a throwaway copy of `inject.js`
     imports a throwaway two-line `permissionGuard.js` stub whose `stripPermissionWidening` always
     returns `null`, proving `injectSkills` itself (not `permissionGuard.ts`) reacts correctly: it throws
     an `Error` naming the skill, the skill is never delivered at `dest`, never recorded in the manifest,
     and never fingerprinted.
   - Mutant M1 (delete the `return null` line, API kept) was confirmed to turn PART D' RED on assertions
     before this fix, and GREEN after it was restored — both files' temp artifacts are cleaned up in a
     `finally`, never touching the real `dist/skills/*.js` files.
2. **MINOR — `fs.rmSync(dest, …)` alone is not fail-safe.** An `EBUSY` on the removal (correlated with the
   SAME rename/write failure that got the caller here — an AV/handle lock on Windows) used to leave the
   unstripped hazard sitting at `dest`, where Claude Code's own discovery still finds and loads it. Fixed:
   `quarantineUndeliverableDest` (`inject.ts`) tries, in order, (i) rename `dest` ASIDE to
   `<cwd>/.claude/.loom-quarantined-skills/<name>-<random>` — OUTSIDE the `.claude/skills` discovery tree
   entirely (a renamed sibling still INSIDE `skills/` is still a skill directory Claude would scan); (ii)
   else overwrite `<dest>/SKILL.md` in place with a neutral, frontmatter-free stub naming the withheld
   skill; (iii) else log loudly at error level. Tested by monkeypatching `fs.rmSync` to throw `EBUSY` for
   one target skill's `dest` and asserting the rename-aside fallback actually fires and no hazardous
   SKILL.md remains anywhere under `.claude/skills`. Mutant M3' (skip the fallback, keep the API) confirmed
   RED before, GREEN after.
3. **SOUNDER STRIP — a stacked trigger could outrun the fixpoint bound.** The round-2 fixpoint loop
   removed exactly one `!` per pass (`stripShellTriggers` matched a single trigger character), so a
   deliberately long run (more `!`s than `STRIP_FIXPOINT_MAX_PASSES`) could exceed the bound before fully
   stripping — fail-closed (the postcondition would still return `null`), but a legitimate-looking input
   needlessly withheld. Fixed: `INLINE_SHELL_RUN_RE`/`FENCED_SHELL_RUN_RE` (`permissionGuard.ts`) match the
   WHOLE run of trigger characters (`!+` in place of `!`) in one application, derived from the imported
   `INLINE_SHELL_RE`/`FENCED_SHELL_RE` patterns' own `.source` rather than a hand-authored second copy, so
   a future change to either shared pattern is picked up automatically. The fixpoint loop and the `null`
   postcondition both stay as defence in depth (item 1 above still needs them wired correctly), but a
   single pass now resolves any realistic stacked trigger on its own.

## Round 4 — quarantine dir excluded unconditionally, bounded, fallbacks (ii)/(iii) tested (card `fb5b91c0`)

A Code Review of round 3's own `quarantineUndeliverableDest` (worker `b666b7b3`) found the function itself
sound but three gaps around it, all fixed in the same pass:

1. **The quarantine dir was NOT git-excluded.** `hideFromGit`'s own entries (`doctrineGitExcludeEntries`,
   `pty/claude-doctrine.ts`) only ever covered the skill names actually injected, plus
   `settings.local.json` — never `.claude/.loom-quarantined-skills/` itself. A worker's own `git add -A`
   (or a manager/plain session sharing `repoPath` as cwd) could COMMIT an unstripped, agent-authored
   hazardous SKILL.md into repo history — Claude Code would never load it from there (no
   skills/commands/agents segment in a git blob), but it's still a trust-boundary leak into history, and
   a `git check-ignore` run against the un-fixed path confirmed it genuinely wasn't ignored. Fixed:
   `doctrineGitExcludeEntries` now ALWAYS appends `/{CLAUDE_DOCTRINE_DIR}/{QUARANTINED_SKILLS_DIRNAME}/`
   to its returned list, unconditionally — never gated on `skillNames`, and never gated on whether a
   quarantine has actually happened yet in this session (the entry is written on EVERY `hideFromGit` call,
   same as the `settings.local.json` entry already was). `QUARANTINED_SKILLS_DIRNAME` (new, exported from
   `pty/claude-doctrine.ts`) is the ONE source of truth for the literal `.loom-quarantined-skills`, used by
   both `doctrineGitExcludeEntries` and `quarantineUndeliverableDest` itself — so the exclude pattern and
   the actual relocation target can never drift into two spellings.
2. **Unbounded accumulation.** The round-3 shape appended `${name}-${Date.now()}-${crypto.randomBytes(4)
   .toString("hex")}` per failure, so a repeatedly-undeliverable skill (e.g. a persistently locked
   directory on Windows) grew a fresh quarantine dir on every single spawn, forever. Fixed by using ONE
   FIXED name per skill (`quarantineDir/<name>`, no suffix) — every call best-effort-clears any prior
   copy at that exact path (`fs.rmSync(aside, {recursive:true, force:true})`, errors swallowed) before the
   rename, so a failed clear doesn't block the relocation attempt; `fs.renameSync` itself still fails
   closed into fallback (ii)/(iii) if the target genuinely can't be cleared or replaced. A fixed name was
   chosen over pruning the whole quarantine dir at the START of `injectSkills`. `injectSkills` itself is
   synchronous, so this is NOT an in-process race between concurrently-interleaved calls — the real
   problem is simpler and purely sequential: a shared `cwd` (manager/platform/setup/auditor all share
   `repoPath`) means one session's call can run, in full, between two OTHER sessions' calls, and a
   start-of-call prune deletes EVERY name's quarantine entry indiscriminately — including one a sibling
   session wrote moments earlier in its own now-finished call, that nobody has inspected yet. The
   fixed-name replace has no such cross-session hazard: each skill name's own quarantine slot is
   independent, and two sessions quarantining the SAME skill name at the SAME cwd, in either order, lose
   at most each other's forensic copy of THAT one name, never an unrelated one.
3. **Fallbacks (ii) and (iii) were untested.** Only fallback (i) (rename aside) had ever been exercised —
   round 3 itself named this gap but didn't close it. Two new tests
   (`skills-inject-permission-strip.mjs` (n)/(o)) now force BOTH `fs.rmSync(dest, …)` AND
   `fs.renameSync(dest, …)` to throw (forcing fallback (ii): `dest` stays in place, `dest/SKILL.md` is
   overwritten in place with the neutral stub, and the stub has nothing left to detect), and separately
   force rmSync + renameSync + the stub-overwrite `fs.writeFileSync` to ALL throw (forcing fallback (iii):
   `dest` is left completely unmodified, still carrying the original unstripped hazard, with a loud
   error-level `console.log` line actually captured and asserted). `skills-inject-worktree-exclude.mjs`
   also gained a real-git assertion: a probe file written under the quarantine dir is confirmed ignored
   via an actual `git check-ignore -v` call, not just a string match against the raw exclude file.

Named residual (b) below is unchanged by this round — fallback (iii)'s "log loudly, nothing more Loom can
do" ceiling was always the honest floor; round 4 only proves that ceiling is actually reached when every
fallback above it fails, it doesn't raise it.

## Named residuals

(a) **An unstamped human customization of a bundled skill is stripped.** If a human customized a bundled
    skill's `allowed-tools`/`hooks`/shell trigger OUT OF BAND — a failed best-effort provenance stamp, a
    corrupt provenance map (see card `9a3dea30`'s own residual), or an edit that predates provenance
    tracking entirely — `needsPermissionStrip` has no provenance signal to read as `"human"`, so it falls
    through to the fail-closed agent/unstamped path and the customization is stripped on delivery. This is
    ACCEPTABLE: the posture this whole card establishes is fail-closed by construction (decision record
    `509176c8`'s same posture), and a human who wants this back has the Skills UI/REST path, which stamps
    provenance correctly going forward.
(b) **What remains if every dest-cleanup fallback fails.** `quarantineUndeliverableDest`'s three fallbacks
    (rename aside, overwrite with a stub, log loudly) are ordered from "most robust" to "least invasive
    requirement" — but if the directory is locked hard enough that even a single-file overwrite of
    `SKILL.md` fails, the unstripped hazard can still be left sitting at `dest`, discoverable by Claude
    Code. The loud error-level log (fallback iii) is the only signal in that case; there is no further
    software-only mitigation beyond it — a human operator would need to intervene on the host.

## Fingerprint ordering

The strip call in `inject.ts`'s copy loop runs BEFORE `fingerprintSkillDir`/
`recordLoomPlacedFingerprint` — the recorded placement fingerprint always covers the POST-strip bytes
actually left on disk, so the cwd-skill permission scan (`permission-scan.ts`, card `015fdb23`) correctly
recognizes Loom's own stripped delivery as unmodified-since-placement rather than flagging it as
"edited after placement."

## Do not

- Do not add refuse/strip logic to `skills/permissionWidening.ts` itself — decision record `87a51903`
  forbids it; `skills/permissionGuard.ts` is the one place for this.
- Do not hand-copy `FRONTMATTER_RE`/`FRONTMATTER_KEY_LINE_RE`/`INLINE_SHELL_RE`/`FENCED_SHELL_RE` into a
  third location — import the exports `permissionWidening.ts` carries for exactly this reuse.
- Do not skip the refuse check for the dev-only bundled-asset-edit branch of `skillWriteData` — every
  call through that function is agent-authored regardless of branch; a human who genuinely needs
  `allowed-tools`/`hooks` in a bundled skill edits the repo file directly, never through `skill_write`/
  `skill_edit`.
- Do not strip a human-provenance-stamped store skill, or a bundled-asset name whose store copy is still
  content-equal (normalizeForCompare-tolerant) to the shipped asset (round 2 — see "Round 2" above; a bare `isBundledSkill(name)` check
  is NOT enough on its own) — the background report's own disposition table is: bundled-and-pristine:
  reviewed at merge, lint guard only; human: warn, never strip — stripping a human's deliberate,
  attributable choice would silently and invisibly break a skill they chose to install.
- Do not treat an unstamped user skill, OR a DIVERGED bundled-name store copy (round 2), as clean for
  strip purposes — both MUST read as agent-written (fail closed), the same posture decision record
  `509176c8` already established for locked-role delivery.
- Do not let a strip failure (an unreadable SKILL.md past `ENOENT`, `stripPermissionWidening` returning
  `null`, or all 3 write/rename attempts failing) leave the unstripped hazard delivered at `dest`,
  `placed`, or fingerprinted (round 2) — treat it exactly like a copy failure: remove `dest`, record the
  name as `failed`, skip the fingerprint.
- Do not run `stripFrontmatterKeys`/`stripShellTriggers` a single time and call it closure (round 2) — a
  doubled/tripled trigger needs the fixpoint loop; verify `detectPermissionWidening` of the RESULT is
  actually empty rather than assuming one pass sufficed.
- Do not reorder the strip call to run AFTER the obsidian-fragment append or the fingerprint computation
  in `inject.ts` — the fragment must land on an already-stripped base, and the recorded fingerprint must
  cover the bytes actually delivered, or the cwd-skill permission scan can mis-flag Loom's own stripped
  copy as edited.
- Do not drop the BOM-handling in either function on the premise that card `22813c50` hasn't yet settled
  whether the CLI honours a BOM-led block — refuse/strip fail closed regardless of that open question.
- Do not use a bare `try { fs.rmSync(dest, …) } catch {}` to clear an undeliverable skill's `dest` (round
  3) — use `quarantineUndeliverableDest`, whose rename-aside/stub-overwrite/log fallbacks are what keeps a
  removal failure from leaving the unstripped hazard sitting where Claude Code's discovery still finds it.
- Do not rename an undeliverable skill's dir aside to anywhere still INSIDE `.claude/skills` (round 3) —
  Claude Code's own discovery walk would still find and scan it there; the quarantine target must be
  outside that tree entirely.
- Do not hand-author a second copy of `INLINE_SHELL_RE`/`FENCED_SHELL_RE`'s lookbehind/fence bound for the
  whole-run strip patterns (round 3) — derive `INLINE_SHELL_RUN_RE`/`FENCED_SHELL_RUN_RE` from the shared
  patterns' own `.source`, so a future change to either is picked up automatically.
- Do not assume a crafted real fixture (however many stacked `!`s) can exercise `stripPermissionWidening`'s
  `null`-postcondition branch once the round-3 whole-run strip ships (see PART D' above) — test it via a
  deliberately injected (forced-always-dirty) detector instead, never by trying to outrun the bound with
  real content.
- Do not gate the quarantine dir's git-exclude entry on `skillNames`, or on whether a quarantine has
  actually happened yet this session (round 4) — `doctrineGitExcludeEntries` must append it
  UNCONDITIONALLY, every call, exactly like the `settings.local.json` entry.
- Do not hand-copy the quarantine dir's literal name into a second spot (round 4) — both
  `doctrineGitExcludeEntries` and `quarantineUndeliverableDest` must import `QUARANTINED_SKILLS_DIRNAME`
  from `pty/claude-doctrine.ts`, never re-spell `.loom-quarantined-skills` locally.
- Do not go back to a timestamp+random quarantine name (round 4) — it accumulates without bound; use the
  ONE FIXED name per skill, replacing any prior copy (best effort) on every call.
- Do not prune the whole quarantine dir at the start of `injectSkills` as an alternative to the fixed name
  above (round 4) — `injectSkills` is synchronous, so this is not an in-process race; a shared `cwd`
  (manager/platform/setup/auditor) means a start-of-call prune in one session's call deletes a sibling
  session's own still-uninspected forensic copy, written by an earlier, already-finished call.
- Do not treat fallback (ii) (stub overwrite) or (iii) (loud log) as implicitly covered by fallback (i)'s
  own test (round 4) — each failure mode needs its OWN fault injection (force rmSync+renameSync to reach
  (ii); force rmSync+renameSync+the stub write to reach (iii)), since a reviewer confirmed round 3 shipped
  both untested.
