# 015fdb23 — disable skill shell execution for Loom-driven roles, plus a bounded cwd-skill permission scan

From the background report `research/skill-frontmatter-permission-widening-2026-11-02.md` (card `28b2ca6f`).
A repo's own `.claude/skills` (in a session's cwd) is never filtered by Loom. A skill there can carry
`` !`cmd` ``/fenced ` ```! ` (shell at render time), `allowed-tools` (a turn-scoped grant), and `hooks:`
(persists for the rest of the session). The CLI's own `disableSkillShellExecution:true` setting
neutralizes the first of the three for every non-bundled skill source; the other two have no non-managed
CLI lever at all.

**Round 2 folds in card `979f29b9`** ("feat(companion): warn at spawn when repo skills carry hooks or
allowed-tools"), itself the delivery of **owner decision `f635bad6`** (2026-11-02 ~21:03Z, verbatim: "Warn
only" — the Companion runs inside the owner's project repos, Claude Code gives Loom no lever to neutralize
`hooks:`/`allowed-tools`, so the owner chose warn-loudly-never-block, matching Claude Code's own trust
model). `979f29b9` was never dispatched separately — its triage note explains why: this card's scan
already escalates for role `assistant` (979f29b9's whole scope), so round 2 just adds what 979f29b9 named
as still missing: the shared detector (below) and the push dedupe.

**Round 3** is a Code Review pass on round 2's own shipped shape. Seven findings, all addressed except
one accepted residual (6) and one honestly-reported gap (7) — see "Round 3 findings" below for each.

**Round 4** is a Code Review pass on round 3's own shipped shape. Eight items — see "Round 4 findings"
below for each.

## What this card does

1. `writeSessionSettings` (`pty/claude-settings.ts`) sets `disableSkillShellExecution: true` for every
   `LOOM_DRIVEN_ROLES` session (`worker`, `setup`, `auditor`, `workspace-auditor`, `run`, `assistant` —
   read the array itself, not a restated copy) — `isLoomDrivenRole()` (`shared/types.ts`) is the one place
   that tests membership; `disallowedToolsForRole` (`pty/host.ts`) was refactored to call it too, so the
   two checks can't drift apart.
2. `createPty` (`pty/host.ts`), right after `injectSkills`, and GATED on that SAME `isLoomDrivenRole`
   check (round 3) so manager/platform/operator/plain sessions never run it at all, runs a bounded scan
   of `<cwd>/.claude/skills` (`scanCwdSkillsForPermissionFrontmatter`, `skills/permission-scan.ts`) for a
   non-Loom-owned skill carrying `allowed-tools:`/`hooks:` frontmatter — the two fields
   `disableSkillShellExecution` has no lever for. The matching itself routes through the ONE shared
   detector, `detectPermissionWidening` (`skills/permissionWidening.ts`, card `87a51903`), filtered down
   to `allowed-tools`/`hooks` — never a second hand-rolled pattern set (that card's own record forbids
   it). A hit on the entries cap (more than `PERMISSION_SCAN_MAX_ENTRIES` directory entries) is ITSELF
   reported via the scan's `truncated` array (round 3); a `"readBytes"` truncation report is narrower
   (round 4, item 1) — gated on the skill's own frontmatter block not having closed within what was read
   (`frontmatterReadIncomplete`), never merely on the FILE exceeding `PERMISSION_SCAN_MAX_READ_BYTES` — see
   "Round 3 findings" item 1 and "Round 4 findings" item 1. A scan that could not fully run at all (a
   non-ENOENT `readdir` error, or an existing-but-unreadable SKILL.md) sets `incomplete:true` on the
   result instead (round 4, item 2) — never folded into a clean read.
3. On a finding (a real detection, a reported bound-hit, OR `incomplete:true` — round 3 item 1, round 4
   item 2): (a) a loud `console.error` daemon line names every repo-relative `SKILL.md` path and vector
   (`skillPermissionFindingPath`) for a real detection, and a separate loud line for a bound-hit or an
   incomplete scan; (b) exactly one durable `skill_permission_frontmatter_warning` event per spawn
   (`SessionService.handleSkillPermissionFrontmatterWarning`) carrying `findings` and (when non-empty)
   `truncated`, and (when true) `incomplete`; (c) for role `assistant` only, an owner-visible push via the
   EXISTING attention surface (`companion/attention-push.ts`'s `classify()`/`alertLine()` — no new UI),
   DEDUPED per `(cwd, sorted {skill name, content hash}[] + sorted {cap, names, skippedCount, size,
   mtimeMs} truncated[])` (round 4, item 4 widened the truncated half of the key) so a resume/recycle with
   unchanged content never re-pushes — `detail.isRepeat`, stamped by the handler (the one place with DB
   access) and read by the pure `classify()`, carries the decision; the durable event still lands every
   spawn either way, only the push is gated. An `incomplete` scan NEVER updates or clears this key (round
   4, item 2) — it always surfaces (`isRepeat:false`) without disturbing whatever baseline a genuinely
   complete scan last recorded. A genuinely CLEAN scan (zero findings, zero truncated, not incomplete —
   round 3, item 5) instead clears the stale dedupe key and appends no event at all, for any in-scope role.

## Do not

- Do not widen `disableSkillShellExecution` to `manager`/`platform`/`operator`/a plain session without a
  fresh decision — `LOOM_DRIVEN_ROLES` deliberately excludes them (the owner may rely on `!` in their own
  interactive session; manager/platform legitimately surface decisions to a human watching live).
- Do not assume the cwd-skill scan covers anything beyond `<cwd>/.claude/skills` itself. Claude Code's own
  skill discovery also walks nested `<subdir>/.claude/skills` (on first file touch) and parent directories
  up to the repo/worktree root — none of that is scanned here. This is a deliberate, named scope limit
  (see `detail.scope` on the event itself, and `scanCwdSkillsForPermissionFrontmatter`'s own doc), not an
  oversight — closing it fully would mean re-implementing the CLI's own discovery walk on the daemon side,
  which this card does not attempt.
- Do not flag a Loom-owned skill name through this scan WHEN its current content fingerprint still
  matches what `injectSkills` recorded placing (round 3: bare `claimedByLoom` membership is no longer
  enough on its own — see "Round 3 findings", item 3). A name claimed by this session, or any other live
  session sharing the cwd, whose SKILL.md was edited AFTER placement (no matching recorded fingerprint)
  IS scanned like any other non-Loom-owned content. A genuinely unmodified claimed name is covered by the
  separate dispositions in the background report (refuse-at-write for an agent-written store skill;
  warn-on-save in the Skills UI for a human-written one) — flagging that case here too would just
  double-warn the same content through two channels.
- Do not classify a non-`assistant` role's warning as `"escalation"` in `companion/attention-push.ts`'s
  `classify()` — only `detail.role === "assistant"` gets the owner-visible push (it's the one locked role
  that runs in an ordinary, worker-writable user project — every other in-scope role is a project the
  owner already set up and is watching, or is a session a manager already escalates for through its own
  channels). Every other in-scope role's warning classifies `"notice"` instead: durable, visible on the
  event log, but not pushed to the owner by default.
- Do not raise `PERMISSION_SCAN_MAX_ENTRIES`/`PERMISSION_SCAN_MAX_READ_BYTES` (`skills/permission-scan.ts`)
  without re-measuring the spawn-path cost — the scan runs inline and synchronously on every spawn for an
  in-scope role, right next to `injectSkills`'s own already-synchronous I/O; it is bounded specifically so
  a pathological `.claude/skills` directory can't add unbounded latency to every spawn.
- Do not add `skill_permission_frontmatter_warning` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/
  `ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` (`shared/types.ts`) — same reasoning the file already
  documents for `codex_auto_commit`/`process_survived_kill`: it's a detect-and-notify-only marker, not a
  worker/manager lifecycle signal any of those four track.
- Do not hand-copy `detectPermissionWidening`'s regexes into `permission-scan.ts` (or anywhere else) —
  import the function. Card `87a51903`'s own record: a divergent hand-copied set silently disagrees about
  which skills are flagged.
- Do not assume `PERMISSION_SCAN_MAX_READ_BYTES` (4096) always contains a skill's frontmatter for
  `detectPermissionWidening`'s own purposes — that detector requires its CLOSING `---` fence to be present
  in the string it's given (no `|$` fallback), so a frontmatter BLOCK that itself exceeds the read cap is
  still a real MISS at the detection layer (proven in `skill-permission-frontmatter-scan.mjs`'s PART1-9b)
  — a real SKILL.md's frontmatter is a handful of lines, nowhere near this cap, so this is not something
  to route around. Round 3: that miss is no longer SILENT — the same scan reports it as a `"readBytes"`
  truncation (PART1-9c), so a reader is told to look closer even though `detectPermissionWidening` itself
  is unchanged.
- Do not compute or compare the push dedupe anywhere other than
  `SessionService.handleSkillPermissionFrontmatterWarning` — it is the one place with DB (`app_meta` via
  `getMeta`/`setMeta`) access on this path; `companion/attention-push.ts`'s `classify()` only ever READS
  the already-decided `detail.isRepeat`, never re-derives it (keeps `classify()` pure, same as every other
  event kind it handles).
- Do not key the dedupe on the session id, the role, or the raw findings array order — it is
  `skill-perm-warn-last:<comparisonKey(session.cwd)>` → `JSON.stringify` of the findings sorted by skill
  `name` with each one's `contentHash` (sha256 of the exact bytes the scan read), PLUS (round 3) the
  sorted `truncated` entries — a different session id at the SAME cwd (a resume/recycle) must still
  dedupe; a different cwd (a different repo) must never dedupe against another repo's stored key.
- Do not persist `contentHash` onto the durable event's `detail.findings` — it exists only to feed the
  dedupe decision at filing time; the event's own `findings` stay `{name, fields}`, unchanged from round 1.
- Do not gate the loud `console.error` daemon line (requirement (a), card `979f29b9`) on role — it fires
  for every in-scope role's finding, independent of whether that role's warning ever reaches the owner.
- Do not run the scan (or anything that depends on it) for a role `isLoomDrivenRole` excludes (round 3,
  finding 2) — manager/platform/operator/plain sessions are the owner's own (interactive, or already
  watched by a human), and the "shell vectors already neutralized" premise the scan's own narrowed
  vocabulary (`SCAN_FIELDS`, excluding `shell-inline`/`shell-fenced`) depends on is only TRUE for a role
  `disableSkillShellExecution` actually covers — those are the same role set by construction
  (`isLoomDrivenRole`), so gate both on it, never two different checks that could drift apart.
- Do not clear the push-dedupe key (`skill-perm-warn-last:*`) anywhere other than a genuinely CLEAN scan
  (zero findings, zero truncated, NOT incomplete — round 4) for role `assistant` (round 3, finding 5) — a
  scan that still has something to report must never clear it mid-alert; only the all-clear case does.
- Do not report a `"readBytes"` truncation merely because a SKILL.md's real file size exceeds
  `PERMISSION_SCAN_MAX_READ_BYTES` (round 4, item 1) — report it ONLY when the frontmatter block itself
  didn't close within what was read (`frontmatterReadIncomplete`, `permissionWidening.ts`). A big body
  past the cap, with a small frontmatter closed well within it, carries no missed-detection risk.
- Do not fold a scan's own I/O failure (a non-ENOENT `readdir` error, or an existing-but-unreadable
  SKILL.md) into a clean result (round 4, item 2) — `SkillPermissionScanResult.incomplete` must be `true`,
  and a caller must treat it exactly like a real finding for dedupe purposes (never clear, never trust as
  a new comparison baseline).
- Do not read the on-disk `.loom-skills-fingerprints.json` sidecar for the scan's own exclusion decision
  (round 4, item 3) — it lives inside the very `.claude/skills` directory the scan reads, so anything that
  can write `evil/SKILL.md` there can also forge a manifest+sidecar entry claiming Loom placed it. Read
  `inject.ts`'s daemon-side `loomPlacedFingerprintsByCwd` registry instead — populated only at the exact
  instant THIS process's own `injectSkills` call places a skill, never from disk.
- Do not omit `skippedCount`/`size`/`mtimeMs` from the truncation dedupe key (round 4, item 4) — a hooked
  skill whose file keeps changing while still past the `readBytes` cap, or whose `"entries"` skip count
  changes, must keep re-alerting rather than dedupe against stale truncation metadata.
- Do not render the Companion's `skill_permission_frontmatter_warning` truncation alert line without
  naming the affected skill(s) (bounded, `TRUNC_NOTE_NAMES_MAX`) and `skippedCount` (round 4, item 5) — a
  bare "scan truncated at its X cap" told the owner nothing about which skill(s) or how many were skipped.

## Round 3 findings (Code Review on round 2's shipped shape)

1. **[MAJOR, fixed]** Both scan bounds (`PERMISSION_SCAN_MAX_ENTRIES`, `PERMISSION_SCAN_MAX_READ_BYTES`)
   used to fail SILENTLY — a hostile repo could pad past either cap to evade the scan entirely (64 dummy
   dirs alphabetically ahead of a hooked skill; a 4 KB `description:` pushing the closing `---` fence past
   the read cap). Fixed: `scanCwdSkillsForPermissionFrontmatter` now returns `{findings, truncated}`, and
   a cap hit is reported via `truncated` (`cap: "entries" | "readBytes"`, naming the affected skill(s), a
   `names` list bounded by `TRUNCATION_NAMES_MAX`, and — for `"entries"` — a true `skippedCount`). The
   `readBytes` case fires on the REAL file size exceeding the cap (via `fstatSync`), never on "we happened
   to read exactly the cap". Both caps' loud reporting is proven with the exact padding shapes from the
   finding (`skill-permission-frontmatter-scan.mjs` PART1-9a/9c/10a-d).
2. **[Minor, fixed]** The scan now runs ONLY for `isLoomDrivenRole(opts.role)` (`pty/host.ts`,
   `createPty`) — a manager/platform/operator/plain session's own repo never gets console noise or an
   event. This also makes the scan's "shell vectors already neutralized" premise (why it never flags
   `shell-inline`/`shell-fenced`) true by construction, since that's the exact same role set
   `disableSkillShellExecution` covers.
3. **[Minor, fixed]** A claimed name is now excluded ONLY when its current content fingerprint matches
   one `injectSkills` actually recorded placing (`InjectSkillsResult.claimedFingerprints`, reusing
   `fingerprintSkillDir` from card `31f997e7` — never a second hashing scheme). An edited-after-placement
   claimed name has no matching fingerprint and so IS scanned.
4. **[Minor, fixed]** A real (unsubclassed) `createPty` wiring test
   (`skill-permission-scan-createpty-wiring.mjs`) now drives the actual spawn path via `LOOM_CLAUDE_BIN`
   substitution (mirrors `boot-mode-settings-argv-coupling.mjs`), proving the settings key, the real
   `onSkillPermissionFrontmatterWarning` firing, and the fingerprint-matched exclusion all actually reach
   that call — not just the pure-function/direct-settings-call tests that existed before. RED-proven via
   `negative-control --ref 1032942c` on `host.ts`/`permission-scan.ts`/`inject.ts`.
5. **[Minor, fixed]** A clean scan (zero findings, zero truncated) for role `assistant` now clears the
   stale `skill-perm-warn-last:*` key instead of leaving it to dedupe against a sighting from before the
   repo went clean — a later re-appearance of the SAME content re-alerts.
6. **[Question, accepted]** `contentHash` covers only the bytes this scan reads (the SKILL.md head, up to
   `PERMISSION_SCAN_MAX_READ_BYTES`) — a hooked skill whose referenced EXTERNAL script changes gets no
   re-push, since the scanned SKILL.md bytes are unchanged. Accepted under "warn only": the owner decision
   this card delivers is to warn loudly and never block, not to achieve complete coverage of every way a
   skill's effective behavior can change. Two further nitpicks need no action, noted here only: a throw
   inside `injectSkills` loses `claimedNames`/`claimedFingerprints` for that spawn (the scan then treats
   every name as unverifiable and scans it — fails toward scanning, the safe direction); and the
   per-cwd `app_meta` dedupe rows are unbounded (one row per distinct cwd ever seen at role `assistant`,
   never pruned) — a real-world row count several orders of magnitude below any practical SQLite concern.
7. **[Requested]** The CR asked for the round-1 real-spawn A/B result to be pasted into this record IF a
   persisted artifact exists, and to say so honestly otherwise — NOT to re-run a real `claude` spawn to
   manufacture one. None exists: the round-1 worker's own `driver.cjs` harness persisted no output file,
   so its `sentinelWritten=false` result for arm A is unrecorded anywhere this round could find (searched
   this repo, the project's shared research dir, and this session's own scratch dir — zero hits). That
   real-spawn proof is `research/skill-frontmatter-permission-widening-2026-11-02.md`'s own measurement,
   described in that report's prose, not reproducible from a surviving log.

## Round 4 findings (Code Review on round 3's own shipped shape)

Eight items, all addressed.

1. **[MAJOR, fixed]** The `"readBytes"` truncation used to fire on ANY SKILL.md over
   `PERMISSION_SCAN_MAX_READ_BYTES` (4096), even when the whole frontmatter block was read well within
   that cap and only the BODY afterward was oversized — 11 of Loom's own 14 bundled skills are over 4 KB.
   That escalated to the owner on entirely harmless repos, training the owner to ignore the alert and
   defeating "warn only". Fixed: `permissionWidening.ts` gained `frontmatterReadIncomplete(content)` —
   true only when `content` OPENS a frontmatter block (`---` at the start) and its OWN closing fence is
   not found within `content` — reusing the exact same `FRONTMATTER_RE` anchor `detectPermissionWidening`
   itself uses (never a second hand-rolled fence pattern). `scanCwdSkillsForPermissionFrontmatter` now
   gates the `"readBytes"` truncation on `head.truncated && frontmatterReadIncomplete(head.content)`
   instead of `head.truncated` alone. Proven both ways in `skill-permission-frontmatter-scan.mjs`: a big
   body / small frontmatter (PART1-9a/9a2) is now clean, the existing huge-frontmatter-past-the-cap shape
   (PART1-9c) still truncates, and Loom's own actual largest bundled skill (`orchestrate/SKILL.md`,
   copied byte-for-byte into the fixture, PART1-9a3/9a4) scans clean end to end.
2. **[MAJOR, fixed]** A scan that could NOT fully run — a non-ENOENT `readdir` error (EACCES/EBUSY/
   EMFILE/…), or a SKILL.md that exists but can't be read — used to be silently folded into a clean
   result (`{findings:[], truncated:[]}`, indistinguishable from a verified-empty directory), which for
   role `assistant` would even CLEAR the push dedupe key as if the repo had genuinely gone clean. Fixed:
   `SkillPermissionScanResult` gained `incomplete: boolean`; `readHead`'s failure shape now distinguishes
   `"missing"` (no SKILL.md — the ordinary case) from `"error"` (exists but unreadable); a non-ENOENT
   `readdir` failure on the target dir, or any per-entry `"error"`, sets it. `handleSkillPermissionFrontmatterWarning`
   treats `incomplete` exactly like a real finding/truncation: it is never "nothing to report", and while
   it's set the handler neither clears NOR updates the stored dedupe key (so a real prior baseline
   survives untouched, and the incomplete scan itself always surfaces, never dedupes). Tested in
   `skill-permission-frontmatter-scan.mjs` PART1-11/11a (readdir ENOTDIR on a `.claude/skills` that's a
   FILE, not a dir), PART1-12/12a (SKILL.md that's a DIRECTORY, not a file — EISDIR on read), and PART3-I1
   through I4 (the dedupe-survives-an-incomplete-scan behavior end to end).
3. **[MAJOR, fixed]** `injectSkills`'s `claimedFingerprints` used to be built from the on-disk
   `.loom-skills-fingerprints.json` sidecar — which lives INSIDE the very `.claude/skills` directory the
   scan reads, so anything able to write `evil/SKILL.md` there could also forge a manifest+sidecar entry
   claiming Loom itself placed it (with a correctly self-computed fingerprint — the attacker has full read
   access too), dodging the scan entirely. Fixed: a daemon-side, in-memory registry
   (`loomPlacedFingerprintsByCwd` in `inject.ts`), populated ONLY at the exact instant THIS process's own
   `injectSkills` call places a skill — never read back from disk. `claimedFingerprints` is now built from
   this registry, filtered to `cwd`, instead of the sidecar union. After a daemon restart the registry is
   empty, so every claimed name fails toward being SCANNED until this process places it again (never
   toward trusting an unverifiable claim) — the intended, visible-by-default posture. The on-disk sidecar
   is UNCHANGED for its other, legitimate consumer (the dead-claim cleanup in the same file), which
   genuinely needs cross-restart persistence and was never the vector here. Proven in
   `skill-permission-frontmatter-scan.mjs` PART4: 4a drives a REAL placement through `injectSkills` and
   confirms the scan excludes it end to end (the fix mustn't just make everything unconditionally
   scanned); 4b forges both sidecars for an `evil-skill` (internally consistent — the "attacker" computed
   the real fingerprint) and confirms `claimedFingerprints` has no entry for it and the scan still flags
   it.
4. **[Minor, fixed]** The truncation push-dedupe key hashed only `{cap, names}` — `skippedCount` was
   dropped entirely, and there was no `size`/`mtime` at all, so a hooked skill whose file kept CHANGING
   while still past the `readBytes` cap (or whose `"entries"` skip count changed) would dedupe forever
   against stale metadata. Fixed: `SkillPermissionScanTruncation` gained optional `size`/`mtimeMs` (read
   off the SAME `fstatSync` call `readHead` already makes — never a second stat), and the dedupe key now
   includes `skippedCount`/`size`/`mtimeMs` for every truncation entry. Tested in
   `skill-permission-frontmatter-scan.mjs` PART3-T1/T2/T3 (readBytes size/mtime change) and PART3-E1/E2
   (entries skippedCount change).
5. **[Minor, fixed]** `attention-push.ts`'s truncation alert line said only "scan truncated at its X
   cap" — no skill name, no count, telling the owner nothing actionable. Fixed: the line now names up to
   `TRUNC_NOTE_NAMES_MAX` (3) affected skills (with a "+N more" tail beyond that) and the `skippedCount`
   when present, plus a new `incomplete`-only branch (round 4, item 2's own owner-facing surface) so an
   I/O-error scan says so rather than falling through to the generic "a permission-widening concern"
   fallback. Tested in `companion-attention-push.mjs`'s new truncation-only / many-names / incomplete-only
   `alertLine` assertions — the `truncNote` branch (and the `incomplete` branch) had NO test coverage
   before this round.
6. **[Recorded, no code change]** `skill-permission-scan-createpty-wiring.mjs` exits 0 on
   `process.platform !== "win32"` (the same gap `boot-mode-settings-argv-coupling.mjs` already has) — so
   ubuntu CI (`.github/workflows/ci.yml`) never actually runs its assertions, only ever observes the
   SKIP-and-exit-0 path. The real `LOOM_CLAUDE_BIN` spawn proof for this card has only ever run on the
   owner's own Windows dev host.
7. **[Nitpick, fixed]** `CWD_SKILLS_SCAN_SCOPE` moved out of `skills/permission-scan.ts` into
   `pty/claude-dirname.ts` — the existing zero-import leaf module `CLAUDE_DOCTRINE_DIR` already lives in,
   derived from that same constant. `companion/attention-push.ts` now imports it from there directly
   instead of from `permission-scan.ts`, which otherwise pulled in `inject.ts` and pty-doctrine modules
   transitively for a module that only ever needed one string literal. `permission-scan.ts` re-exports the
   constant so every other existing consumer is unaffected.
8. **[Nitpick, fixed]** `skill-permission-scan-createpty-wiring.mjs`'s header trimmed the CR-round-3
   incident history and the inline RED-proof recipe down to a pointer at this record (which already
   carries both, under round 3's own finding 4) — kept the assertion list `(a)/(b)/(c)/(2)` and the
   Windows-only note verbatim.
