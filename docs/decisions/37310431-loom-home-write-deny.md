# 37310431 — deny agent-role native Edit/Write/Bash writes into LOOM_HOME through the spawn permission policy

## Background

Every Loom agent role (worker/manager/platform/setup/auditor/workspace-auditor/assistant/run/operator/
plain) has unrestricted native `Edit`/`Write`/`Bash` unless its profile sets `restrictedTools:true`
(opt-in, default off). Before this card, no deny rule covered `LOOM_HOME` for those tools — a session
could write `~/.loom/skill-provenance.json`, `~/.loom/skills/**`, `.env`, `restart-intent.json`, the DB
files, etc., defeating daemon-side trust mechanisms (e.g. `509176c8`'s skill provenance stamping).

## Round 2 (this revision) — what changed and why

A security review of round 1's shipped design found two problems, both load-bearing enough to change the
shape, not just patch it:

**A. The path form was undocumented and probably wrong on POSIX.** Round 1 emitted
`Edit(<LOOM_HOME_REAL>/...)`  — an absolute OS path, forward-slashed, with no special prefix. Claude
Code's own permission docs say a single-leading-slash pattern is relative to the **settings file's own
directory**, not an absolute anchor — so a rule shaped like `Edit(/home/u/.loom/**)` from a `--settings`
file probably matches nothing real on POSIX. The documented absolute form is `//<path>` (and, on Windows,
`//<drive-letter>/<rest>` — no colon). Round 2 emits that form on every OS, via one helper
(`toClaudeAbsoluteGlob`, `pty/loom-home-deny.ts`) — see Ruling A below for the measurement.

**B. The "deny everything present" design broke the Platform/Setup homes.** Round 1 unioned a static
registry with a live `readdirSync` of LOOM_HOME's top level, denying anything found there whether
registered or not. But the reserved "Platform" home AND the "Setup" home bind `repoPath`/`vaultPath` to
LOOM_HOME itself (`platform/seed.ts`, `setup/seed.ts`) — so a session spawned there runs with
`cwd===LOOM_HOME` and **legitimately writes notes directly under it**: the Platform Lead's own
`PLATFORM-LEAD-RESUME*.md` (and its `.archive/` siblings), `research/`, `lead-resume-archive/`, and the
home's own `CLAUDE.md`. (`reports/` was WRONGLY included in this list in an earlier draft — fix round 2
corrected it: that path is Node's own crash-forensics `--report-directory`, not a Platform Lead note
path, and is now denied like `crash.log` — see "The registry" below.) A fail-closed "deny everything
present" denies the real note paths too, breaking both homes. Round 2 drops the readdir pass entirely and
denies ONLY a named,
known-SENSITIVE path, via a static registry, for EVERY role — with NO per-role exemption needed, because
a note/working path (for any role, not just Platform/Setup) is simply never listed in the registry to
begin with. See `paths.ts#LOOM_HOME_WRITE_DENY_REGISTRY`'s own doc for the current membership, and the
new `test/loom-home-write-deny-registry-guard.mjs` guard (added to `STATIC_GUARD_REPO_PATHS`) for what
keeps a future `path.join(LOOM_HOME, …)` call site from silently falling through the gap this drop would
otherwise reopen.

## Investigation findings (real-spawn measurements, claude-cli 2.1.286, Windows)

All measured in a throwaway OS temp dir, never under the real `~/.loom`, with a matched no-deny control
for every claim below.

1. **`Write(<glob>)` is REJECTED by the CLI at settings-load.** The CLI's own diagnostic: *"Write(path)
   is not matched by file permission checks — only Edit(path) rules are... Edit rules cover all
   file-editing tools."* The only valid rule name for this feature is `Edit(...)`.
2. **`Edit(<glob>)` blocks both the Edit and Write tools** (confirmed via real file-state checks both
   ways, matched against a no-deny control that genuinely wrote the files).
3. **Mode matters.** Under `acceptEdits`, the CLI's own built-in behavior already confines file tools
   AND recognized Bash-write patterns to the session's working directories, even with zero deny rules —
   an attempt outside cwd is refused with *"outside this session's working directories... needs
   approval... not performed."* Under `auto` (the mode most roles actually run in once cycled up), this
   built-in confinement is ABSENT — with no deny, Edit/Write/Bash all write freely outside cwd.
4. **An `Edit(<path>/**)` deny, under `auto` mode, ALSO blocks Bash writes into that path** — tested via
   plain `>` redirect, `tee`, `cp`, and shell-variable-indirected redirect (`OUTDIR="..."; echo >
   "$OUTDIR/f"`). The CLI's own tool-result for the indirected case, verbatim: `Permission to use Bash
   with command OUTDIR="..."; echo INDIRECT > "$OUTDIR/indirect.txt" has been denied.` — a genuine
   engine-level denial (not model self-censorship: the identical command with the SAME path and NO deny
   rule succeeded, confirmed on disk both ways). This generalizes the prior project-memory finding ("a
   `Read()` deny also blocks Bash `cat`") to `Edit()`-deny blocking common Bash write idioms too.
5. **Deny still applies under `bypassPermissions` mode** (confirmed: an `Edit()` deny still blocked a
   write even with `mode:"bypassPermissions"`).
6. **⭐ LOAD-BEARING: deny BEATS allow, with no carve-out.** A broader `Edit(<parent>/**)` deny plus a
   narrower `Edit(<child>/**)` allow still blocks writes into the child (confirmed on disk: both the
   sibling AND the "allowed" child were blocked in the same run). Gitignore-style negation
   (`"!Edit(...)"`) inside `deny[]` is NOT supported either — the CLI logs *"matches no known tool —
   check for typos"* and ignores it. **This kills the obvious design** (a single blanket
   `Edit(LOOM_HOME/**)` deny with an `allow` carve-out for the legitimate write paths) — the deny rule
   SET must exclude the legitimate paths from its own globs, not rely on an allow override.
7. **A sub-dir-scoped deny does NOT cover a brand-new sibling top-level file.** `Edit(<HOME>/skills/**)`
   does not block `Write` creating `<HOME>/newconfig.json` (confirmed: the file was created, with the
   model's own narration explicitly noting the write "went through without a permission prompt"). Round 1
   read this as "the deny must be built from a live disk scan, not a static list alone" — round 2's
   actual fix is narrower: the registry must name every sensitive path EXPLICITLY (including a
   lazily-created one that may not exist yet), since there is no live scan left to catch an unregistered
   one. A genuinely new, unregistered sensitive path still needs a registry addition — see the
   `loom-home-write-deny-registry-guard.mjs` guard, which exists to make a human decide that, rather than
   relying on a disk scan to paper over it.

### Ruling A — the documented `//`-absolute path form, measured

Re-ran the Windows real-spawn proof (`test/loom-home-write-deny-real-spawn.mjs`) against the new
`//c/Users/...`-shaped rules (see the file's own captured evidence block for the exact run). **The
documented form works on Windows** — a denied write using the `//<drive>/...` glob was blocked exactly
like round 1's plain-drive-letter form was. Round 1's form had empirically happened to work on Windows
(a drive-letter-prefixed path isn't ambiguous with "relative to the settings-file directory" the way a
POSIX single-leading-slash path is) — but it was never the documented form, and nothing here was ever
measured against a real POSIX host. **POSIX real-spawn verification is explicitly OUT of scope for this
card** — this repo's own daemon runs on Windows; a separate card
(`8d0ba38b-927a-4e1c-9684-6cc77e2f93c6`, "verify and fix absolute-path permission deny rules on Linux and
macOS") owns that verification, plus `SETTINGS_DIR_READ_DENY_RULE` and the transcript-root deny rules
(`TRANSCRIPT_ROOT_DENY_RULES`), which this card deliberately does NOT touch — those two use the
single-leading-slash form today and are a DIFFERENT card's concern.

### Ruling D — does the deny cover deleting/renaming the protected directory NODE itself?

Measured via two added Bash probes in the same real-spawn test, against pre-existing registered
directories (`LOGS_DIR` for `rm -rf`, `SKILL_BASE_DIR` for `mv`) — a different operation from writing a
file WITHIN the directory, which is what every other probe in that file measures. **Result (measured
2026-10-01, claude-cli 2.1.286, Windows, worker role, `auto` mode): `rm -rf` on the registered directory
was BLOCKED (it survives); `mv` on the registered directory was also BLOCKED (it stayed at its original
name).** See `test/loom-home-write-deny-real-spawn.mjs`'s own captured `OBSERVED` lines for the exact
run.

**Mechanism NOT attributed.** This measurement has no no-deny control (removing the deny and re-running
the SAME two commands to confirm they'd otherwise succeed) and `auto` mode's own built-in classifier
independently refuses many destructive commands REGARDLESS of any deny rule — so this result cannot
distinguish "the `Edit(<path>/**)` deny rule blocked it" from "the engine would have refused this `rm`/
`mv` anyway." Do not cite this as proof the deny rule itself covers directory-node deletion/rename; it is
only proof that the OVERALL spawn (deny rule + whatever else the engine does in `auto` mode) blocked it,
on this one measurement.

### Case-variant probe (delta security review, item 4) — correction: NOT reproduced as a bypass, mechanism not attributed

A 7th Bash probe was added to the real-spawn test: a lowercase-everything variant of the same absolute
path as the registry-covered target. Windows resolves both to the same file on disk; a case-sensitive
TEXT-matching glob engine would be the mechanism that lets this matter — case-insensitive filesystem
resolution is why a bypass would be POSSIBLE at all, not something that would cause a block. (An earlier
draft of this record had that backwards.)

**Result (measured 2026-10-01, claude-cli 2.1.286, Windows, worker role, `auto` mode): bypass NOT
reproduced — the lowercase-everything variant's content was not found written.** This is NOT proof the
deny blocks case variants. "The file wasn't created with `DENIED_CASE_VARIANT`'s content" is
observationally IDENTICAL to three different causes: (a) the deny rule matched the variant and refused
it, (b) the model declined to run command 7 at all (e.g. after an earlier denial), or (c) a shell-level
failure unrelated to any permission rule. There is no matched no-deny control (re-running the SAME seven
commands with the deny removed) to distinguish these, the same gap Ruling D has. Single real-engine
measurement (n=1) either way — re-measure after a `claude` CLI upgrade, same posture as every other
Bash-coverage claim in this record. See `test/loom-home-write-deny-real-spawn.mjs`'s own captured
`OBSERVED` line and its neighboring comment for the exact run (also prints the full emitted
`permissions.deny` array for this spawn, confirming every entry used the documented `//c/...` form, per
item 3).

## Design

`pty/loom-home-deny.ts` builds the deny set at every spawn (`PtyHost.createPty`, the same chokepoint
`withSettingsDirDenyForSpawn`/`withTranscriptRootDenyForSpawn` already use), as a **flat map over the
static registry** (`paths.ts#LOOM_HOME_WRITE_DENY_REGISTRY`) — round 2 dropped the live `readdirSync`
pass round 1 unioned it with (see "what changed and why" above) — **UNIONED with the PER-ENTRY
role-conditional instruction registry** (`LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY`, added by the delta
security review's item 1). `loomHomeWriteDenyRules` accepts `{role, sessionId}`: `role` is read (the
instruction registry's per-entry `exemptRoles` check, plus the unconditional `role===null` exemption);
`sessionId` is accepted for interface stability but is UNUSED — there is no sessionId-keyed logic
anywhere in this module. The output is therefore **role-DEPENDENT**, not independent — a worker/manager/
etc. spawn's rules differ from a platform spawn's by exactly the three instruction-registry entries.

LOOM_HOME is resolved via `canonicalizeExistingPath` (`projects/repos.ts`, the same junction/symlink-
collapsing helper `git/repo-lock.ts`/`vault/versioner.ts` already use), once, at module load — never the
raw unresolved `LOOM_HOME` string (the one existing precedent, `SETTINGS_DIR_READ_DENY_RULE`, does NOT
resolve it, which this module deliberately does not repeat for the broader write deny).

**The MAIN registry is role-unconditional** — every entry applies to every role; a note/working path
simply isn't in it. **The INSTRUCTION registry is role-conditional, per entry** — see its own section
below and {@link LoomHomeInstructionWriteDenyEntry}'s doc in `paths.ts`.

### The registry (`paths.ts#LOOM_HOME_WRITE_DENY_REGISTRY`)

Denies a named, known-sensitive path — the DB files (+ its SQLite WAL/SHM siblings), secret/loopback
keys, `.env`, `.gitignore` (defense-in-depth for `secret.key` — see `ensureLoomHomeGitignore`), the
skills/companion-skills/companion-memory stores + `skill-provenance.json`, `restart-intent.json`,
`last-shutdown.json`, `crash.log`, `reports/` (Node's `--report-directory` for fatal-error/uncaught-
exception reports — crash forensics, same class as `crash.log`; fix round 2 corrected an earlier, WRONG
reading of this as a Platform Lead note path — see "Deliberate exclusions" below), the daemon-supervisor
pid, `daemon.pid` (bin/loom.mjs) and `update-config.json` (update/check.ts + bin/update-config.mjs) —
both constructed via a PARAMETER, not the literal `LOOM_HOME` identifier, so registered BY HAND since the
guard test (below) can never find either call site itself — the daemon-supervisor log (covered by the
`logs/` dir entry), `bin/`, `deploy-backup/`, `merge-danger-latches/`, `merge-quarantines/`, the settings
dir, `codescape/`, `backups/`, `python/` (covers its venv + model caches), `gate-output/`, `gate-timing/`,
`archives/`, `codex-rollout-archive/`, and every known `tmp/` child other than `tmp/scratch`
(`tmp/settings`, `tmp/decision-records`, `tmp/companion-audio`, `tmp/claude-usage.json`). Read the
registry's own doc comment for the live membership rather than trusting this list to stay in sync with
it — it will drift, this file will not be updated in lockstep.

### The instruction registry (`paths.ts#LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY`) — delta security review, item 1 (MAJOR)

A SEPARATE, role-conditional registry denying files a more-privileged FUTURE session reads as
INSTRUCTIONS, not data: `PLATFORM-LEAD-RESUME*.md` (`composePlatformLeadStartupPrompt` reads it verbatim
into every Platform Lead spawn), `CLAUDE.md`, and `.claude/**` (both read by the harness itself at every
session's boot). Before this, ANY role could overwrite these and inject instructions into a future,
more-privileged session's prompt — a cross-role prompt-injection vector the main registry's data/secrets
framing never covered.

**Card `d332c969` added four more entries, at the SAME exact-cwd roots (`platformRoot: "repoPath"`, same
mechanism as `CLAUDE.md`/`.claude/**` above): `CLAUDE.local.md` (file), `.claude/rules` (dir), `AGENTS.md`
(file), and `.claude/AGENTS.md` (file).** The CLI's own docs (code.claude.com/docs/en/memory) confirm the
harness reads all four at the exact session cwd — `CLAUDE.local.md` alongside `CLAUDE.md`, `.claude/rules/
**` either unconditionally (no `paths:` frontmatter) or lazily on a matching file read, and `AGENTS.md`/
`.claude/AGENTS.md` as the project-instructions file Claude reads INSTEAD of CLAUDE.md when no CLAUDE.md/
CLAUDE.local.md exists anywhere at or above cwd. Zero new candidate-resolution logic: each new entry reuses
the identical `repoPaths`-rooted rebind loop the CLAUDE.md/`.claude/**` entries already use, so the
same-root/split-rebind/platform-exemption behavior is identical, entry-for-entry. See "Not closed here"
below for what this did NOT close.

**Denied PER ENTRY, not via one shared exempt-role set (fix round 2, item 1 — Code Review
CHANGES-NEEDED).** The original shape exempted `platform`+`setup` from the WHOLE registry. Code Review
caught that this broke the registry's own purpose: `setup` is a LOWER-privilege operator with native
Edit/Write/Bash and a cwd that's ALSO LOOM_HOME, so it could still write `PLATFORM-LEAD-RESUME*.md`
(injected verbatim into every Platform Lead spawn) and `CLAUDE.md`/`.claude/**` (the harness loads both
at boot) — exactly the cross-role escalation this registry exists to close. Today, every entry's
`exemptRoles` is `["platform"]` only; `setup` is NOT exempt from any of the three. A plain, human-driven
session (`role===null`) is exempt from the WHOLE registry unconditionally (checked once, not per-entry —
see `pty/loom-home-deny.ts`'s `loomHomeWriteDenyRules`). The per-entry shape (rather than hard-coding
"platform only" as a second shared set) is deliberate: a FUTURE entry could need a different exemption
without widening every other entry's.

The `PLATFORM-LEAD-RESUME*.md` entry uses a MID-SEGMENT `*` glob (measured to work by the delta security
review) rather than a trailing `/**` — the ordinary `kind:"file"` shape (no directory suffix), since
`ruleFor` only decides whether to append `/**`, not whether `relPath` itself already contains a glob
character — so one rule covers both the base filename and any per-lineage
`PLATFORM-LEAD-RESUME-<lineageId>.md` sibling.

**Deliberately does NOT cover a resume-doc rotation's `<name>.archive/` sibling directory**
(`orchestration/resume-doc-snapshot.ts`). The justification is NOT "only the daemon writes there" — Code
Review caught that this premise is wrong: an agent (the Platform Lead itself, per its own doctrine) can
also write a rotation archive there, not just the daemon's boot-time snapshot. The real justification is
that **nothing auto-injects an archive file's content into a prompt** — `composePlatformLeadStartupPrompt`
reads the ACTIVE resume doc only; an archived snapshot is read ONLY on demand, if a human or agent
explicitly opens it. An archive file sitting there, written by anyone, carries no path by which its
content reaches a future session's prompt the way the active doc's does — so it was never in scope for
either registry on that ground, independent of who writes it. Confirmed writable for platform in the
unit tests (`loom-home-write-deny.mjs`).

### The guard test (`test/loom-home-write-deny-registry-guard.mjs`, in `STATIC_GUARD_REPO_PATHS`)

Source-scans every `path.join(LOOM_HOME, …)` / `path.resolve(LOOM_HOME, …)` call site — originally
`packages/daemon/src/**/*.ts` only; the delta security review widened this to also scan `.mjs` files
under the repo-root `bin/`/`scripts/` and `packages/daemon/scripts/` — and fails when the literal path it
constructs is covered by NEITHER registry nor its own small `ALLOWLIST` (scratch/workspaces/runs —
`reports` was WRONGLY allowlisted here in the first delta-review pass; Code Review's second pass caught
it and moved it into the main registry instead, see "The registry" above).
Its own GAPS header (read it there, not here) now also names: LOOM_HOME passed as a PARAMETER rather than
the literal identifier (the single biggest blind spot — `update/check.ts`, `bin/update-config.mjs`,
every `bin/loom.mjs` call via its own `loomHome()` accessor); the `PLATFORM_HOME_PATH`/`SETUP_HOME_PATH`
alias constants (`platform/seed.ts`, `setup/seed.ts` — each `= LOOM_HOME` directly, nothing to scan today,
but a future `path.join(PLATFORM_HOME_PATH, …)` would be invisible to this guard); and that widening the
scan to `bin/`/`scripts/` catches `scripts/daemon-supervisor.mjs`'s literal `LOOM_HOME` call sites while
STILL missing every `bin/**` call site (all via the `loomHome()` accessor, the same parameter blind spot).

### Deliberate exclusions (never denied — structural omission from the registry, not allow-based, per
finding 6 above)

- **`SCRATCH_ROOT_DIR`** (`$LOOM_SCRATCH_DIR`, every session, every role) — `/worker` doctrine's own
  stash-avoidance recipe writes here via Bash redirection (`git diff -- <file> >
  "$LOOM_SCRATCH_DIR"/<name>.patch`); `scratchDirEnv` tells EVERY session this path unconditionally.
- **`WORKSPACE_ROOT`** (every role) — CLAUDE.md names `~/.loom/workspaces/` as where verification
  screenshots / mockup deliverables land via native Write/Bash.
- **`RUNS_DIR`** (every role, including `run`'s own cwd) — round 2's scope cut: round 1 denied every
  OTHER session's `runs/*` entry via the readdir pass while excluding only a `run` session's own; round 2
  denies none of it. `runs/*` holds ordinary working directories, not secrets, and policing cross-session
  access to them is no longer this card's concern.
- The Platform/Setup homes' `research/`/`lead-resume-archive/` note paths need no explicit exclusion
  either — they're simply never constructed via a `path.join(LOOM_HOME, …)` constant in source, so
  they're never in either registry to begin with, for any role. `CLAUDE.md`/`.claude/**`/the resume doc
  ARE now in the instruction registry (above) — their Platform/Setup writability comes from that
  registry's own role exemption, not from omission.

### Known, disclosed gaps (not closed by this card)

The registry only denies what's EXPLICITLY listed. A brand-new, genuinely sensitive LOOM_HOME-rooted path
introduced by a future feature needs a registry addition — the guard test above makes that a loud,
reviewable failure rather than a silent gap, but it is still a human decision each time, not an automatic
one the way round 1's readdir pass was for an UNREGISTERED-but-present path. This is the tradeoff round 2
makes deliberately in exchange for not breaking the Platform/Setup homes.

The guard test's biggest named blind spot (see its own GAPS header) is LOOM_HOME passed as a PARAMETER
rather than the literal `LOOM_HOME`/`LOOM_HOME_REAL` identifier — `update/check.ts`, `bin/update-config.mjs`,
and every `bin/loom.mjs` call site (via its own `loomHome()` accessor) all construct a real LOOM_HOME-
rooted path the guard's regex can never see. `daemon.pid` and `update-config.json` are registered BY
HAND for exactly this reason; a FUTURE such path needs the same manual treatment — the guard cannot catch
it automatically.

**CLOSED by card `00a999e8` (three rounds, the last two from Code Review): the instruction registry now
covers a rebound Platform home, PER ENTRY (not via one shared root) and PER CANDIDATE (not via one path per
entry).** `platformLeadBaseResumeDocPath(homePath)` (and its lineage sibling) resolve against
`project.vaultPath`; `CLAUDE.md`/`.claude/**` are read by the harness itself relative to the SESSION'S OWN
SPAWN CWD — `startPlatformLead` pins `cwd: project.repoPath` at a FRESH spawn, but `recyclePlatformLead`
pins `cwd: old.cwd` and a resume reuses `session.cwd` unchanged (`sessions/service.ts`) — so that cwd is
NEVER re-derived from the project row after spawn. Two different roots, and the repoPath one is NOT even
single-valued over time.

Round 1 of this fix rooted every instruction-registry entry at one shared path (the project's `vaultPath`
alone) — Code Review caught that this left CLAUDE.md/`.claude/**`'s real root (`repoPath`) uncovered the
instant a rebind actually split the two. Round 2 fixed that with a per-entry `platformRoot: "vaultPath" |
"repoPath"` field (`paths.ts`) naming which of the Platform project's two bound paths each entry's own real
reader follows, but still rooted `"repoPath"` at a SINGLE value (`project.repoPath`) — Code Review's second
pass caught that this still missed a LIVE or still-resumable Lead session that was spawned/recycled BEFORE
a rebind and is still reading its OLD `cwd`: `project.repoPath` alone only tells you what a FRESH spawn
will use, not what an in-flight lineage is actually reading right now.

**Round 3 (this revision): `platformHomePaths.repoPaths` is a SET, not one path.** The caller
(`index.ts`'s `getPlatformHomePaths`) unions `project.repoPath` with `db.listSessionCwdsForProjectRole(
projectId, "platform")` — the DISTINCT `cwd` of every NON-ARCHIVED, non-`"dead"` platform-role session of
the project — in one callback, two DB reads. `loomHomeWriteDenyRules` (`pty/loom-home-deny.ts`) iterates
every candidate in `repoPaths` for a `"repoPath"`-rooted entry (canonicalizing + comparing each against
`LOOM_HOME_REAL` exactly as before), emitting a rule per distinct real root; `vaultPath` stays single-valued
(the resume doc is always resolved FRESH against the project's current `vaultPath`, never pinned on a
session row the way `cwd` is). When the Platform project was never seeded (LOOM_DEV off), or a candidate
set is empty/every candidate equals LOOM_HOME_REAL, that entry's rebound pass is a pure no-op —
byte-identical to before this card.

**Accepted consequence, not special-cased (Code Review's ruling):** if `repoPath` is ever rebound to an
ANCESTOR directory — e.g. the user's own home directory — every non-platform role gets
`Edit(<that ancestor>/.claude/**)` (and the matching `CLAUDE.md` rule) denied. This is CORRECT, not
over-broad: a Platform Lead spawned with that cwd genuinely reads `.claude/**`/`CLAUDE.md` from exactly
that directory, so the deny is describing a real reader, however broad the directory. No carve-out is
warranted — narrowing it would just reopen the same hole for that specific rebind shape.

See `pty/loom-home-deny.ts`'s own doc on `LoomHomeDenyOptions.platformHomePaths`/`loomHomeWriteDenyRules`,
`paths.ts`'s doc on `LoomHomeInstructionWriteDenyEntry.platformRoot`, and `db.ts`'s doc on
`listSessionCwdsForProjectRole` for the mechanism; `test/loom-home-write-deny.mjs`'s "Card 00a999e8"
section — including the SPLIT-rebind case (repoPath and vaultPath at two different, non-LOOM_HOME
directories) and the DB-level "Lead cwd outlives a rebind" scenario (a live Lead session's `cwd` from
BEFORE a rebind, plus the project's CURRENT `repoPath` from AFTER it, both independently denied; an
archived session, a `resumability:"dead"` session, and a wrong-role session all confirmed to NOT
contribute a candidate) — for the coverage proof, plus a dedicated WIRING proof (a real `PtyHost` built
with an injected `getPlatformHomePaths`, spawned for real, asserting the rebound rule reaches the actual
WRITTEN `settings.json` — not just the pure function's return value).

`bin/service.mjs`'s `path.join(loomHome, "service")` dir (the Task Scheduler/launchd XML artifact,
another `loomHome()`-parameter instance of the blind spot above) is DELIBERATELY left unregistered — the
artifact is rewritten immediately before `schtasks`/`launchctl` consumes it, so there's no persistent
window where a planted file there could matter. See the guard test's own GAPS header for the same note.

**Partially closed by card `d332c969` — investigated first, confirmed against the real CLI (2.1.287) and
its own docs. The registry now covers every instruction file the harness reads at the EXACT cwd/vaultPath
it knows about** (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/**` — which includes `.claude/
rules/**` and `.claude/AGENTS.md` — plus the resume doc), **but two surfaces the harness ALSO reads remain
OPEN, deliberately NOT built here, pending an owner decision (`d332c969` question, routed via
`question_ask`):**

1. **The ancestor-directory walk.** Claude Code loads `CLAUDE.md`/`CLAUDE.local.md`/`AGENTS.md` from
   EVERY directory above the session's cwd, all the way to the filesystem root (no git/home-directory
   boundary — confirmed in the CLI's own docs, "every directory above it"). With the default LOOM_HOME
   (`~/.loom`), that means `~/CLAUDE.md` (and higher, e.g. a Windows drive root) is a Platform Lead
   instruction source no role is denied — the registry above only covers the pinned root itself, never
   its ancestors. Two designs are on the table: enumerate every ancestor between the pinned root and the
   filesystem root and deny each one (write-side, symmetric with the registry above, but genuinely
   unbounded in where it stops); or set `claudeMdExcludes` in the Lead's/Setup's OWN per-session
   `--settings` file (written by `writeSessionSettings`, `pty/claude-settings.ts`) to exclude every path
   above the pinned root from what THAT session loads (read-side, bounded, but silently drops any
   legitimate ancestor content). The manager's recommendation to the owner is the read-side
   `claudeMdExcludes` option.
2. **The fixed, always-loaded user-level files `~/.claude/CLAUDE.md` and `~/.claude/rules/**`.** These are
   NOT part of the ancestor walk — they load once per session regardless of cwd, documented as "personal
   preferences for all projects"/"apply to every project on your machine." Denying non-platform-role
   writes here would stop EVERY role from ever editing the owner's own global Claude Code memory/rules,
   for every project, forever — plausibly a deliberate owner workflow (see `loom-skills-architecture`
   project memory on the personal-vs-project `.claude/skills` split), so this is an owner call, not an
   agent one.

Not Loom's to close without that decision: the managed-policy `CLAUDE.md`
(`/Library/Application Support/ClaudeCode/CLAUDE.md`, `/etc/claude-code/CLAUDE.md`,
`C:\Program Files\ClaudeCode\CLAUDE.md`) requires OS-admin/root to write, which no Loom agent role runs
with — low real risk, not tracked as a gap here.

### MEASURED (card `b180791a`): the external-`@import`-approval dialog HANGS an unattended spawn — availability risk CONFIRMED, not fail-closed

The question this section used to leave open — does the CLI's external-import approval dialog
fail-closed (import silently skipped) or hang an unattended, Loom-driven spawn — is now measured, not
open. **Result: it hangs.** Real-spawn proof: `test/claude-md-external-import-dialog-real-spawn.mjs`
(MANUAL-ONLY, same posture as this card's other real-spawn files).

**Setup:** a fresh, throwaway `LOOM_HOME` + two fresh throwaway cwds, real worker-role spawn (the same
`--disallowedTools AskUserQuestion ExitPlanMode EnterPlanMode …` argv every unattended Loom role gets).
`covered`'s project `CLAUDE.md` contains `@../external-outside-cwd/note.md` — a relative import that
resolves OUTSIDE `covered`'s own cwd, the exact "external" shape the CLI's own docs define. `control`'s
`CLAUDE.md` mentions the identical path in prose, with no leading `@` (matched no-import control, same
shape/size, isolating the import mechanism as the only difference).

**Measured (claude-cli 2.1.287, Windows, worker role, `acceptEdits` mode):**
- `control` (no import): real SessionStart hook fired, a submitted turn went busy and back to idle
  (Stop fired) in ~3s. Normal completion — establishes this host's real baseline latency for the run.
- `covered` (external import): the real SessionStart hook **never fired**, even after a 60s bounded poll
  — i.e. the dialog blocks the CLI before Loom's own hook wiring ever sees the session start, not merely
  before the first turn. A further 120s bounded poll on the busy/idle signal (in case SessionStart was
  merely slow) also never resolved. Captured raw terminal screen (ANSI-stripped) shows the dialog
  verbatim: *"Allow external CLAUDE.md file imports? This project's CLAUDE.md or .claude/rules imports
  files outside the current working directory. Never allow this for third-party repositories. External
  imports: `<path>\external-outside-cwd\note.md` … ❯ No, disable external imports / Yes, allow external
  imports / Enter to confirm · Esc to cancel"* — a genuine interactive TUI prompt, waiting on a keypress
  nobody unattended ever sends.

**This is the SAME dialog family `pty/claude-config.ts`'s `ensureTrusted` already pre-clears two
instances of** (the workspace-trust dialog and the per-project MCP-server-enable prompt — see that
function's own doc comment, which literally says those two "block an unattended spawned `claude` from
reaching SessionStart" if left unanswered). `ensureTrusted` does **not** pre-clear this third one. Checked
the real `~/.claude.json` project entry for the hung `covered` cwd after the run: it carries only
`hasTrustDialogAccepted`/`enabledMcpjsonServers` (what `ensureTrusted` already writes) — no third
decided-flag for external imports exists yet, so there's nothing for `ensureTrusted` to also set without a
small follow-up investigation to identify the real persisted-decision schema (the same kind of reverse-
engineering `discoverProjectMcpServerNames`/`disabledMcpjsonServers` already did for the MCP-prompt case,
item 2 above) — not done here; this card's scope was to measure the outcome, not build the fix.

**Which roles are exposed:** every unattended Loom-driven role — worker, setup, auditor,
workspace-auditor, manager, and (`LOOM_DEV`-gated) platform — spawns with no human on stdin, and this
dialog is a native CLI TUI prompt entirely independent of `--disallowedTools` (it isn't one of the
MCP-adjacent human-prompt tools that flag denies; it's a memory-loading-time trust gate keyed on cwd).
Only this file's `worker` role was actually spawned — the mechanism is structurally role-independent (it
fires on ANY external import at ANY cwd, before role-specific tool wiring is even relevant), so the result
generalizes to every other unattended role without re-spawning each one; a `plain`/human-interactive
session is the one case genuinely unaffected, since a human is actually present to answer the dialog.
Any instruction file a more-privileged future session reads — a Lead's `CLAUDE.md`, a manager's project
`CLAUDE.md`/`.claude/rules`, a worker's project `CLAUDE.md` — that contains (or is edited by anyone, not
just an attacker, to contain) an external `@import` can wedge that spawn indefinitely: no turn, no
`worker_report`/`done`/`blocked`, nothing — it just sits there consuming a concurrency slot until a human
notices and hard-kills it. This is a genuine availability risk, not merely a theoretical one.

**Fixed by card `e789ef3b`** — see the "FIXED (card `e789ef3b`)" section immediately below for the
discovered key names, the two read sites, and the never-overwrite rule. (This paragraph used to describe
the fix as not-yet-built; it is built as of that card.)

### FIXED (card `e789ef3b`): the external-import dialog is now pre-decided — DECLINE, only when undecided

The persisted-decision key(s) `~/.claude.json`'s project entry uses for this dialog, discovered by
**static decompilation of the installed CLI's own bundle** (claude-cli `2.1.287`, Windows — the same
version `b180791a` measured against) — NOT by answering the dialog interactively (no real dialog was
answered; the bundle's own un-mangled property names and a default/empty-project-entry literal gave an
unambiguous, citable answer without needing to). No documented schema exists for these keys; re-check
on a future CLI upgrade, same posture as every other reverse-engineered `.claude.json` key in this file.

**The keys**, in the per-project entry `hasTrustDialogAccepted` already lives in:
- `hasClaudeMdExternalIncludesApproved` (boolean) — the actual choice. `true` = "Yes, allow external
  imports"; `false` = "No, disable external imports".
- `hasClaudeMdExternalIncludesWarningShown` (boolean) — set to `true` on EITHER answer.

**Two distinct read sites — do not conflate them:**
1. Whether the dialog RE-APPEARS: the CLI's own re-show check reads `Approved || WarningShown` — skips
   showing it again once EITHER flag is true, regardless of which way it was decided.
2. Whether external-import CONTENT actually LOADS: a separate site (the memory-file loader) gates
   purely on `Approved` — `false` means external imports are structurally never read into context. This
   is what makes writing `Approved:false` genuinely fail-closed, not merely "dialog silenced."

**The fix**: `ensureTrusted` writes `{hasClaudeMdExternalIncludesApproved:false,
hasClaudeMdExternalIncludesWarningShown:true}` — the same shape "No, disable external imports" persists
interactively — but **only into a GENUINELY UNDECIDED entry** (`isExternalImportDecided` in
`claude-config.ts`: neither flag already `true`). A plain/human session and the owner's own interactive
`claude` runs share these SAME project entries, so an entry that already carries an explicit approval or
an existing decline (ours or a human's) is left untouched — Loom never revokes a human's own decision for
their own folder. A fresh worker worktree's entry is always undecided, so it is always declined.

**The upgrade-path case**: `isFullyDecided`/`isTrusted`'s fast path now ALSO requires
`isExternalImportDecided`, not just `hasTrustDialogAccepted` — so a project entry that was already
trusted by an OLDER Loom build (no import flags at all) is no longer treated as "nothing to do"; its next
`ensureTrusted` call reaches the lock and writes the decline. Before this, such a pre-existing entry would
have passed the old `isTrusted`-only fast path and never gotten the new keys, leaving the hang open for
every project that was already trusted before this fix shipped.

**⚠️ Round 1's keying claim above was WRONG for a linked worktree — corrected by round 2 immediately
below.** Round 1 wrote the decline into `key = path.resolve(dir).replace(/\\/g,"/")`, the SAME entry
`hasTrustDialogAccepted` lives in — true for a non-worktree cwd, but for a Loom worker (always a linked
git worktree) that is the WORKTREE's own path, never what the CLI actually reads for this dialog. See
"ROUND 2 FIX" immediately below.

**Do not:**
- Do not ever write `hasClaudeMdExternalIncludesApproved:true` for an agent spawn — an external import is
  exactly the cross-role instruction-planting vector this file's own instruction registry (above) guards
  against from a different angle; approving it on the agent's behalf would open the same hole back up.
- Do not overwrite an existing decision (`Approved:true` or an existing `WarningShown:true`) — check
  `isExternalImportDecided` first; a human's own prior choice for their own folder is not Loom's to revoke.
- Do not assume this generalizes past the measured CLI version — these are undocumented bundle
  internals, discovered by decompilation, not a published API; re-verify after any `claude` CLI upgrade.

### ROUND 2 FIX (card `e789ef3b`, after Code Review CHANGES REQUESTED): key the decline on the canonical git root, not `path.resolve(cwd)`

Code Review on round 1 found the CLI itself reads a session's `.claude.json` project entry from
`projects[yIe()]`, where `yIe() = canonicalRootByRoot(cwd) ?? cwd` — for a LINKED WORKTREE (every Loom
worker's cwd), `canonicalRootByRoot` resolves to the MAIN checkout the worktree's `.git` file points back
at, never the worktree's own path. Round 1's decline, written under `key` (the plain worktree path), was
therefore invisible to the CLI at every real worker spawn — confirmed by a read-only census of the real
`~/.claude.json`: 4623 `.loom-worktrees` keys existed with only 2 carrying any CLI-written field at all,
while the real main-checkout key (`C:/Users/danie/Documents/GitHub/loom`) carried the CLI's own
`hasClaudeMdExternalIncludesApproved:false`/`WarningShown:false` (undecided — never answered). Full
investigation: project memory `claude-cli-project-config-keyed-by-canonical-git-root`.

**Owner ruling (request `f8c268c9`, option A, 2026-10-02):** decline at the canonical-repo level when
undecided — accepting that this also declines the dialog for the owner's OWN interactive `claude`
sessions in that repo, if they haven't answered it themselves yet, as the tradeoff for closing the
worker hang.

**The fix**: a new `claudeCliProjectKey(dir)` (`pty/claude-config.ts`) resolves the CLI's own read key —
`resolveGitMainCheckoutRootSync` (`git/repo-lock.ts`) walks the SAME synchronous, no-subprocess ancestor
walk `resolveGitToplevelSync` already uses (@decision 7673d096's constraints apply here too), then, for a
linked worktree (its `.git` is a FILE), follows the `gitdir:` pointer to the private worktree dir and that
dir's `commondir` file (mirroring `git rev-parse --git-common-dir`) to the shared common `.git` — returning
ITS PARENT when that common dir's basename is `.git` (the ordinary layout), or the common dir ITSELF
otherwise (a bare/`--separate-git-dir` repo, whose common dir need not be named `.git` at all — this
mirrors the CLI's own `he(c)!==".git"` branch, confirmed by the same bundle decompilation; card `17237fba`
fixed Loom's resolver to match after it was found unconditionally returning the parent), UNLESS
`<commonDir>/.git` itself exists, in which case it returns the WORKTREE's own toplevel instead — card
`6f52c3f5` (Code Review `24e5a263`) added this nested guard, mirroring the CLI's own
`Ne(_(c,".git"),c) ? e : Nn(c)` sub-branch; its triggering real-git layout could not be reproduced via
plain `git` commands (near-nil exposure), so the hermetic coverage uses a manually-crafted `commondir`
pointer atop a real worktree fixture rather than a layout `git worktree add` itself ever produces — see
`test/repo-lock-subdir-toplevel.mjs`'s own fixture comment. A non-git `dir`
returns `null`, and `claudeCliProjectKey` falls back to the PLAIN `path.resolve` key in that case (the
CLI's own `?? cwd`), with NO case-folding there. **⚠️ For a GIT `dir`, this is NOT true**: the ancestor walk
realpaths via `fs.realpathSync.native`, which canonicalizes drive-letter/8.3 casing on Windows, unlike the
CLI's own casing-preserving resolution — a real, unresolved divergence (card `17237fba`'s review Minor 1),
measured nil exposure today (0 of 8852 real keys lowercase) but not fixed. `ensureTrusted` now writes the
decline under this canonical key, while trust + the per-project MCP-enable prompt stay keyed at the plain
worktree path exactly as before (card `17237fba` owns revisiting THAT keying separately — out of scope
here). On ANY error escaping the resolver, `claudeCliProjectKey` falls back to the plain key too — the
protection is never silently skipped just because canonical-root resolution failed.

Re-verify `canonicalRootByRoot`'s resolution mechanism after any `claude` CLI upgrade — like every other
key in this section, it was discovered by decompilation, not documented.

Real-spawn proof: the `covered` case in `test/claude-md-external-import-dialog-real-spawn.mjs` now
reaches SessionStart, completes a turn, and the external file's sentinel string is absent from the
model's view (RED on pre-fix code — see that file's own header). Hermetic unit coverage:
`test/claude-config.mjs`, including a real `git init` + `git worktree add` fixture proving the decline
lands under the main checkout's key (derived from `git rev-parse --git-common-dir`, never assumed),
that an existing human decision on that key survives a worktree spawn, that an `Approved:true` entry
without `hasCompletedProjectOnboarding` keeps its approval while trust is added, and that a resolver
failure still falls back to writing the plain-key decline rather than skipping it.

### Bash coverage caveat — re-measure on CLI upgrade

Finding 4's Bash coverage is a **model-mediated heuristic classifier** inside the `claude` CLI, not an
OS-level boundary — it inspects the Bash COMMAND TEXT the model is about to run, not what that command
does once it starts executing. No bypass was found among plain-redirect/`tee`/`cp`/shell-variable-
indirected patterns, but a compiled helper binary, a detached/background process, or a path assembled
across multiple separate Bash calls were NOT tested.

**⛔ File I/O from INSIDE a spawned node/python subprocess is NOT covered, by construction — not
"untested," but structurally outside what a command-text classifier can ever see.** `fs.writeFileSync(...)`
inside a `node -e`/node script, `open(...).write(...)` inside a `python -c`/python script, or a direct
`sqlite3`/better-sqlite3 write to `loom.db` from within a spawned process all happen AFTER the classifier
has already approved (or refused) the outer Bash command line — the classifier never sees, and cannot see,
what code running inside that subprocess goes on to do. (An earlier draft of this record claimed "no
bypass found for `python -c`" — that framing is WRONG and is retracted: what was actually tested was a
`python -c` one-liner whose OWN TEXT still looked like a write (resembling the same redirect-shaped
patterns the classifier already recognizes), not a `python -c` script that performs file I/O via `open()`
in a way the classifier's text-matching has no reason to flag.) Treat the Bash-write deny as a measured,
best-effort, text-classifier-level mitigation — never a sandbox, never a guarantee against a subprocess's
own file I/O — and re-measure after any future `claude` CLI upgrade (this was measured against 2.1.286;
the prior project-memory Read()-deny measurement was 2.1.263 and needed re-verification for exactly this
reason).

## Codex harness — no change needed (WRITE-side only — see card 7955458e for the READ side)

`createCodexPty` never threads `opts.permission`/`disallowedTools` at all (confirmed by that method's own
comment) — codex doesn't consume `permission.deny`. For LOOM_HOME **writes** specifically, it needs none:
codex's own OS-level sandbox (`-s workspace-write`) is deny-by-default and grants writes only to cwd (no
`--add-dir` is ever passed — confirmed, zero call sites in this repo). Every codex-eligible role's cwd is
the git worktree (`WORKTREES_DIR`, a sibling of LOOM_HOME, never nested), so LOOM_HOME is already
structurally unreachable, enforced by the OS (ACE DENY on Windows / Landlock·Seatbelt elsewhere, confirmed
cross-platform at codex's own source — `d7657543`) — a stronger guarantee than claude's CLI-classifier-
based deny.

**This section does NOT cover reads** — codex's sandbox_mode never gates reads, on any mode. The
SETTINGS_DIR/transcript-root read-denies (and a project's own authored `permission.deny`) ARE silently
dropped on codex; see `docs/decisions/7955458e` for the investigation, what's mapped vs. disclosed vs.
hard-rejected, and the residual risk left open.

## Incident during implementation (round 1) — a real write DID land under the real `~/.loom`

`loom-home-write-deny.mjs`'s first draft imported `projects/repos.js` (PART 1, the junction-safety
building-block check) BEFORE setting `process.env.LOOM_HOME` for the rest of the file. `repos.js`
transitively imports `paths.js`, which computes its `LOOM_HOME` constant **at module load time** and
caches it — so that early import baked in whatever `process.env.LOOM_HOME` was at that moment (unset in
this direct `node test/...` invocation ⇒ the real `~/.loom`) for the REST OF THE PROCESS, silently. The
registry-based assertions stayed self-consistent (both sides of each comparison used the same, wrong,
cached `LOOM_HOME_REAL`) and passed anyway — only the two assertions that cross-referenced a file written
via a DIFFERENT path variable (`tmpHome`, which was NOT stale) against `fs.readdirSync(LOOM_HOME_REAL)`
caught the drift, by failing. PART 3's real spawn then wrote a throwaway session `settings.json` to the
REAL `~/.loom/tmp/settings/lhwd-real-worker.json`.

This session's own tool access is (independently) denied from reading or touching `~/.loom` at all, so
the stray file could not be self-removed; it is harmless (a settings.json for a session id with no
corresponding row in the real daemon's database — this file used an isolated, in-memory/temp `Db`
instance throughout), but is disclosed here rather than silently left. The fix: `useOwnLoomHome(...)` +
`requireHermeticEnv()` now run as the FIRST executable lines of the file, before any dynamic import.

## Do not

- Do not emit a `Write(...)` rule for LOOM_HOME protection — the CLI rejects it; `Edit(...)` alone covers
  every file-editing tool (Edit/Write/NotebookEdit/MultiEdit).
- Do not pair a broader LOOM_HOME deny with a narrower `allow` carve-out for scratch/workspaces/etc. —
  deny wins unconditionally (measured); the exclusions must stay structural (baked into which globs get
  emitted), never allow-based.
- Do not reintroduce a live `readdirSync` enumeration alongside the registry — that is round 1's "deny
  everything present" design, and it broke the Platform/Setup homes' legitimate LOOM_HOME-rooted note
  writes (see "what changed and why" above). The registry is now the ONLY source of truth for what's
  denied.
- Do not emit the plain-absolute (no-prefix) path form — the CLI's documented absolute form is
  `//<path>` on POSIX and `//<drive>/<rest>` on Windows; emit it via `toClaudeAbsoluteGlob`, the one
  helper this module exposes for that purpose.
- Do not deny `RUNS_DIR`, `SCRATCH_ROOT_DIR`, or `WORKSPACE_ROOT` — see "Deliberate exclusions" above.
- Do not claim the Bash coverage (finding 4) is a structural guarantee — it is a measured, CLI-version-
  sensitive, model-mediated classifier behavior. Re-measure after a `claude` CLI upgrade.
- Do not claim POSIX real-spawn coverage for this deny — it is UNVERIFIED on a real POSIX host; that
  verification belongs to card `8d0ba38b-927a-4e1c-9684-6cc77e2f93c6`, not this one.
- Do not import anything that transitively loads `paths.js` in a daemon test before that test has set
  `process.env.LOOM_HOME` (prefer `useOwnLoomHome` + `requireHermeticEnv`, called first) — see the
  Incident section above for what actually happens when this is gotten wrong.
- Do not add a new `path.join(LOOM_HOME, …)` call site without either a `LOOM_HOME_WRITE_DENY_REGISTRY`/
  `LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY` entry (if sensitive) or a
  `loom-home-write-deny-registry-guard.mjs` `ALLOWLIST` entry (if a legitimate note/working path) — the
  guard test fails a call site covered by neither.
- Do not widen any instruction-registry entry's `exemptRoles` beyond `["platform"]` (and NEVER re-add
  `setup`) without a fresh security review — this registry exists BECAUSE every other role could
  otherwise plant instructions for a more-privileged future session to read; `setup` was exempted once
  already and that was the exact defect fix round 2 corrected. Widening the exemption re-opens that
  vector for whichever role is added.
- Do not root every `LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY` entry's rebound-Platform-home copy at ONE
  shared path (card `00a999e8`'s round 1 did exactly this, caught by Code Review before merge) — the
  resume doc and CLAUDE.md/`.claude/**` have DIFFERENT real readers (`project.vaultPath` vs. the session's
  spawn `cwd`, pinned to `project.repoPath`), and a rebind can split the two apart. Look up each entry's
  own `platformRoot` field instead; a single shared root silently leaves one of the two readers' real
  files uncovered the moment `repoPath` and `vaultPath` genuinely diverge.
- Do not root a `"repoPath"`-tagged entry at `project.repoPath` ALONE, even with the per-entry
  `platformRoot` split in place (card `00a999e8`'s round 2 did this, caught by a second Code Review pass)
  — a Platform Lead session's `cwd` is pinned at spawn/recycle and NEVER re-derived from the project row,
  so a LIVE or still-resumable lineage keeps reading its OLD `cwd` after `project.repoPath` is rebound
  forward. `platformHomePaths.repoPaths` must stay a SET — `project.repoPath` unioned with
  `db.listSessionCwdsForProjectRole(projectId, "platform")` — not a single current value. See the "Lead
  cwd outlives a rebind" test scenario for the concrete failure this closes.
- Do not cite Ruling D (rm/mv on a registered directory) as proof the `Edit(<path>/**)` deny rule itself
  covers directory-node deletion/rename — it has no no-deny control, and `auto` mode's own classifier
  independently refuses many destructive commands. See Ruling D's own "mechanism NOT attributed" note.
- Do not cite the case-variant probe as proof that case variants are blocked — the same gap as Ruling D
  (no no-deny control) plus a second one: "not created" is indistinguishable from "command 7 never ran
  at all." See that section's own correction.
- Do not claim `python -c`/node-subprocess file I/O is covered by the Bash-write classifier — it is
  structurally NOT, by construction (the classifier inspects command TEXT, never what a subprocess does
  once it starts). See the corrected "Bash coverage caveat" above.
- Do not claim the external-`@import`-approval dialog fail-closes for an unattended spawn — it was
  OPEN/unmeasured until card `b180791a`; measured result (claude-cli 2.1.287) is that it **hangs** the
  spawn indefinitely (blocks before SessionStart even fires), not a silent skip. See the "MEASURED (card
  `b180791a`)" section above before asserting either outcome from memory.
- Do not write `hasClaudeMdExternalIncludesApproved:true` for an agent spawn, and do not overwrite an
  existing `hasClaudeMdExternalIncludesApproved`/`hasClaudeMdExternalIncludesWarningShown` decision (a
  human's own prior choice for their own project folder) — see the "FIXED (card `e789ef3b`)" section
  above for `isExternalImportDecided` and why.
- Do not key the external-import decline on `path.resolve(cwd)` — see "ROUND 2 FIX" above:
  `canonicalRootByRoot` means a linked worktree's decline must land under the MAIN checkout's key
  (`claudeCliProjectKey`), never the worktree's own path, or a real worker spawn never sees it.

## Source

Investigation: real-spawn measurements captured in the worker's `worker_report` for card `37310431`
(investigate-first checkpoint, round 1) and re-verified/extended during round 2's implementation and the
two delta security reviews that followed it. Implementation: `packages/daemon/src/pty/loom-home-deny.ts`
(`toClaudeAbsoluteGlob`, `loomHomeWriteDenyRules`), `packages/daemon/src/pty/claude-dirname.ts`
(`CLAUDE_DOCTRINE_DIR`, split out from `claude-doctrine.ts` to stay dependency-free),
`packages/daemon/src/paths.ts` (`LOOM_HOME_WRITE_DENY_REGISTRY`,
`LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY` + its per-entry `exemptRoles`), wired at
`packages/daemon/src/pty/host.ts`'s `createPty`.
Tests: `packages/daemon/test/loom-home-write-deny.mjs` (hermetic — pure rule-building + the role split),
`packages/daemon/test/loom-home-write-deny-real-spawn.mjs` (MANUAL-ONLY real-spawn proof, covering
Rulings A and D plus the item-3 printed-array and item-4 case-variant delta-review additions),
`packages/daemon/test/loom-home-write-deny-registry-guard.mjs` (the registry/allowlist coverage guard,
widened to `bin/`/`scripts/` by the delta review; in `STATIC_GUARD_REPO_PATHS`).

Card `d332c969` (investigate-first, this revision): the four new instruction-registry entries
(`CLAUDE.local.md`, `.claude/rules`, `AGENTS.md`, `.claude/AGENTS.md`) and their tests (same-root,
split-rebind, platform-exemption, literal-registry-entry, and real-spawn-written-settings checks, all
mirroring the existing `CLAUDE.md`/`.claude/**` entries in `loom-home-write-deny.mjs`) — plus the
"Not closed here" section above for the two surfaces still open, pending the owner's decision.
Investigation: the worker's `worker_report` for card `d332c969`, cross-checked against the installed
`claude` CLI's own bundled doctrine text (its `prompt-audit` skill strings and `InstructionsLoaded`-hook
schema) and the live docs at code.claude.com/docs/en/memory.

Card `b180791a` (investigate-first, this revision): measured the external-`@import`-approval-dialog
question the "Not closed here" section used to leave open — see "MEASURED (card `b180791a`)" above for
the finding (hangs, not fail-closed) and the proposed-but-not-built fix.
Test: `test/claude-md-external-import-dialog-real-spawn.mjs` (MANUAL-ONLY real-spawn measurement, in
`NOT_HERMETIC`). Investigation: the worker's `worker_report` for card `b180791a`, cross-checked against
the live docs at code.claude.com/docs/en/memory ("Import additional files").

Card `e789ef3b` round 1 (this revision): built the fix the `b180791a` note left proposed-but-not-built —
see "FIXED (card `e789ef3b`)" above for the discovered key names, the two read sites, and the
decline-only-when-undecided rule. Implementation: `packages/daemon/src/pty/claude-config.ts`
(`isExternalImportDecided`, `isFullyDecided`, `ensureTrusted`). Tests: `test/claude-config.mjs`
(hermetic, extended) and the flipped `covered` case in
`test/claude-md-external-import-dialog-real-spawn.mjs`. Investigation: static decompilation of the
installed `claude.exe` (claude-cli `2.1.287`, Windows) — no interactive dialog answered; the worker's
`worker_report` for card `e789ef3b` has the exact decompiled snippets + byte offsets.

Card `e789ef3b` round 2 (this revision), after Code Review CHANGES REQUESTED and owner ruling (request
`f8c268c9`, option A): see "ROUND 2 FIX" above for the canonical-git-root keying fix. Implementation:
`packages/daemon/src/git/repo-lock.ts` (`resolveGitMainCheckoutRootSync`), `packages/daemon/src/pty/
claude-config.ts` (`claudeCliProjectKey`, `isFullyDecided` widened to take a separate `canonicalKey`,
`ensureTrusted` writing the decline there instead of `key`). Tests: `test/claude-config.mjs`, extended
with a real `git init` + `git worktree add` fixture (main-checkout keying, an existing human decision
surviving a worktree spawn, the `Approved:true`-without-`hasCompletedProjectOnboarding` case, a non-git
cwd, and a resolver-failure fallback). Investigation: the Code Reviewer's own static decompilation of the
installed `claude.exe` (claude-cli `2.1.287`, Windows) plus a read-only census of the real
`~/.claude.json` — captured in project memory `claude-cli-project-config-keyed-by-canonical-git-root`.
