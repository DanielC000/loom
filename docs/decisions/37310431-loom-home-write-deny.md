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

**The resume-doc deny covers LOOM_HOME only, not a rebound Platform home.**
`platformLeadBaseResumeDocPath(homePath)` (and its lineage sibling) resolve against `project.vaultPath`
for the reserved "Loom Platform" project, which is SEEDED to LOOM_HOME (`platform/seed.ts`) but can
later be REBOUND to a different path. The instruction registry's `PLATFORM-LEAD-RESUME*.md` entry is
keyed to `LOOM_HOME_REAL` specifically — a rebound Platform home's resume doc would then live OUTSIDE
LOOM_HOME and escape this deny entirely, for every role. Tracked as a separate card; not fixed here.

`bin/service.mjs`'s `path.join(loomHome, "service")` dir (the Task Scheduler/launchd XML artifact,
another `loomHome()`-parameter instance of the blind spot above) is DELIBERATELY left unregistered — the
artifact is rewritten immediately before `schtasks`/`launchctl` consumes it, so there's no persistent
window where a planted file there could matter. See the guard test's own GAPS header for the same note.

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

## Codex harness — no change needed

`createCodexPty` never threads `opts.permission`/`disallowedTools` at all (confirmed by that method's own
comment) — codex doesn't consume `permission.deny`. It needs none: codex's own OS-level sandbox
(`-s workspace-write`) is deny-by-default and grants writes only to cwd (no `--add-dir` is ever passed —
confirmed, zero call sites in this repo). Every codex-eligible role's cwd is the git worktree
(`WORKTREES_DIR`, a sibling of LOOM_HOME, never nested), so LOOM_HOME is already structurally
unreachable, enforced by the OS (ACE DENY on Windows / Landlock·Seatbelt elsewhere, confirmed
cross-platform at codex's own source — `d7657543`) — a stronger guarantee than claude's CLI-classifier-
based deny.

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
- Do not cite Ruling D (rm/mv on a registered directory) as proof the `Edit(<path>/**)` deny rule itself
  covers directory-node deletion/rename — it has no no-deny control, and `auto` mode's own classifier
  independently refuses many destructive commands. See Ruling D's own "mechanism NOT attributed" note.
- Do not cite the case-variant probe as proof that case variants are blocked — the same gap as Ruling D
  (no no-deny control) plus a second one: "not created" is indistinguishable from "command 7 never ran
  at all." See that section's own correction.
- Do not claim `python -c`/node-subprocess file I/O is covered by the Bash-write classifier — it is
  structurally NOT, by construction (the classifier inspects command TEXT, never what a subprocess does
  once it starts). See the corrected "Bash coverage caveat" above.

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
