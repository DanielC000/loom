# a92a0913 — honour CLAUDE_CONFIG_DIR when locating engine transcripts, and in the transcript-root deny

## Background

`pty/claude-config.ts`'s `claudeJsonPath()` already honoured `CLAUDE_CONFIG_DIR` (Claude relocates
`~/.claude.json` there when it's set). `pty/claude-transcript.ts`'s `engineTranscriptPath`/
`CLAUDE_PROJECTS_ROOT` did not — they computed the transcript root from raw `os.homedir()`
unconditionally. `pty/host.ts`'s `buildSpawnEnv` never scrubs `CLAUDE_CONFIG_DIR`, so the DAEMON's own
process env carries it through to every spawned engine's env by default — which (per the investigation
below) relocates where that engine writes its OWN transcripts. Loom's reader kept looking at the
un-relocated default, silently breaking context stats, the mid-turn sampler, exhaustion detection,
engine-session rotation, and every transcript read.

**Correction (round 3, card `a92a0913`):** the sentence above describes only the DAEMON-env case. A
human-set PROJECT `sessionEnv` entry for `CLAUDE_CONFIG_DIR` overrides that daemon value for one
session's own spawn — `buildSpawnEnv` (`pty/host.ts`, ~L4667) merges `sessionEnv` AFTER `processEnv`, so
a project can pin its spawned engine's config/transcript root to something the daemon process's own env
never carries at all. `claudeConfigHome()` is read fresh per call from `process.env.CLAUDE_CONFIG_DIR`
as seen by the DAEMON process — never per-session — so when a session's `sessionEnv` override diverges
from the daemon's own ambient value, the ENGINE writes transcripts under its own (sessionEnv-relocated)
root while Loom's reader still resolves the DAEMON's root: the two can genuinely differ, and this card
does not close that gap. Tracked as a separate card (`fbb6e8ec`, "resolve the transcript root from a
session's own CLAUDE_CONFIG_DIR"), not fixed here — see "Do not" below.

## Investigation — static decompilation of the installed CLI

Settled by a raw byte-string scan of the installed `claude.exe` (claude-cli `2.1.317`, Windows) — never a
real `claude` spawn, per this card's own constraint. Same method already documented in
`docs/decisions/37310431-loom-home-write-deny.md`.

**`.claude.json`** (byte offset ~283895809): `function XCr(){let o=`.claude${xB()}.json`;return
x(process.env.CLAUDE_CONFIG_DIR||V_(),o)}` — `CLAUDE_CONFIG_DIR`, when set and non-empty, REPLACES the
home-dir base entirely; `V_()` (≈`os.homedir()`) is only the fallback.

**Projects/transcripts root** — confirmed via three independent code paths in the bundle, all the same
shape (replace-the-base, never nest under it):
- Primary session/resume-lookup path (offset 284711015): `function Gm(){return S($e(),"projects")}`,
  feeding the real transcript-lookup functions (`cv`/`hmt`/`ke`/`Vgo`/`BQ`, including the `--resume`
  lookup). `$e` is imported from a shared chunk (`chunk-q5q153yy.js`, confirmed via its own import line
  at offset 284698170) and reused identically across dozens of modules as the canonical config-home
  accessor.
- SDK session-store mirror path (offset 311573777, inlined — no further symbol resolution needed):
  `let O=()=>A(I.CLAUDE_CONFIG_DIR??A(lt(),".claude"),"projects")`.
- Same module, a few lines earlier (offset 311564963): `let
  b=n?.CLAUDE_CONFIG_DIR??process.env.CLAUDE_CONFIG_DIR,C=b??A(lt(),".claude")`.

No OS-conditional branch exists anywhere for `CLAUDE_CONFIG_DIR` itself — it's a plain env read, identical
on Windows/POSIX.

## Asymmetric fallback — `claudeProjectsRoot()` is NOT `path.join(claudeConfigHome(), "projects")`

Caught by the new hermetic test (`test/claude-config-dir-shared-resolver.mjs`) going RED on first write,
before this correction: `.claude.json` (`claudeJsonPath`) and the transcripts root are asymmetric when
`CLAUDE_CONFIG_DIR` is **unset**. `.claude.json` is a sibling FILE directly in `os.homedir()` —
`claudeConfigHome()`'s own fallback, unchanged, matching the already-shipped, already-verified
`claudeJsonPath` behavior. Transcripts, however, live NESTED one level deeper on real disk, under
`<homedir>/.claude/projects` — this file's own pre-existing, already-verified real-disk layout (see
`encodeProjectDir`'s header comment, which predates this card). When `CLAUDE_CONFIG_DIR` **is** set, it
replaces the WHOLE `.claude`-equivalent root for BOTH — no extra nesting either way. Confirmed in the
bundle: `A(CLAUDE_CONFIG_DIR ?? A(homedir(), ".claude"), "projects")` (offset 311573777, cited above) —
the fallback branch explicitly re-appends `".claude"` onto `homedir()`; the override branch does not.

So `claudeProjectsRoot()` (`claude-transcript.ts`) branches explicitly on `process.env.CLAUDE_CONFIG_DIR`
rather than just joining `claudeConfigHome()` with `"projects"` — this is NOT a second, independent
CLAUDE_CONFIG_DIR-fallback implementation (that would be the drift the "Do not" section below bans); it
reads the SAME env var `claudeConfigHome()` already reads, only to pick which of the two real on-disk
shapes applies, since the two consumers' fallback shapes genuinely differ.

## Do not

- Do not re-add a raw `os.homedir()` call anywhere in `pty/claude-config.ts` or
  `pty/claude-transcript.ts` for the config/transcript root — route through `claudeConfigHome()`
  (`claude-config.ts`), the ONE shared resolver. Duplicating the `CLAUDE_CONFIG_DIR` check is exactly the
  drift this card closes.
- Do not simplify `claudeProjectsRoot()` to `path.join(claudeConfigHome(), "projects")` — that drops the
  `.claude` nesting the real on-disk layout needs when `CLAUDE_CONFIG_DIR` is UNSET (caught RED by
  `test/claude-config-dir-shared-resolver.mjs` on first write). See "Asymmetric fallback" below.
- Do not cache the transcript root at module load (the pre-fix `CLAUDE_PROJECTS_ROOT` constant did this,
  inconsistently with `engineTranscriptPath`'s own inline, fresh `os.homedir()` read in the same file) —
  every consumer must read `claudeConfigHome()` fresh per call, same contract `claudeJsonPath()` already
  documented.
- Do not assume this generalizes past the measured CLI version (2.1.317) — reverse-engineered from an
  unmangled bundle, not a published API. Re-verify after any `claude` CLI upgrade.
- Do not assume `claudeConfigHome()`'s DAEMON-process reading of `CLAUDE_CONFIG_DIR` also covers a
  session whose PROJECT `sessionEnv` overrides that var for its own spawn — it doesn't (see the
  "Correction" paragraph above); that gap is card `fbb6e8ec`'s to close, not this one's.

## Named residual — empty vs. relative `CLAUDE_CONFIG_DIR`

The installed CLI treats an EMPTY *or RELATIVE* `CLAUDE_CONFIG_DIR` specially: rather than a plain
homedir fallback, it searches three folders (cwd, the directory Claude Code was started in, and the home
folder) and prints a warning (static decompile, byte offset ~164065137: *"CLAUDE_CONFIG_DIR is empty or
relative here, so the config directory is worked out from each of three folders..."*).
`claudeConfigHome()` reproduces only the EMPTY case correctly (`||` already falls back to
`os.homedir()` for `""`, matching the CLI's own empty-string behavior). A genuinely RELATIVE
(non-empty, non-absolute) override is used AS-IS — not resolved via the CLI's own three-folder search.
Not reproduced deliberately: `CLAUDE_CONFIG_DIR` is documented/expected to be absolute, and the CLI
itself warns against a relative value. Re-verify if this residual ever matters in production.

## The transcript-root deny rules also move with the fix (trust-boundary change)

`claude-transcript.ts`'s `TRANSCRIPT_ROOT_READ_DENY_RULE` (`"Read(~/.claude/projects/**)"`) and
`otherProjectTranscriptDenyRules` were static string literals using a home-relative `~/` glob, computed
once, never parameterized by `CLAUDE_CONFIG_DIR`. Leaving them unmoved while the reader moves would widen
access: once `engineTranscriptPath` honours a relocated root, an `assistant`/`auditor`/
`workspace-auditor`/`manager`/`platform`/`setup` spawn's deny would still only cover the STALE, un-relocated
default path, never the real one.

**Could not conclusively determine, from static analysis, how the CLI's own `permission.deny` glob
matcher expands a leading `~/`** — whether via plain `os.homedir()` or via the `CLAUDE_CONFIG_DIR`-aware
accessor. Several unrelated tilde-expansion sites were found in the bundle (sandboxed-network credential
masking, SSH/AWS config-pointer resolution, bash-command path classification) but none confirmed as the
specific `Read(<glob>)`/`Edit(<glob>)` permission-rule matcher. The pre-existing comment this file already
carried (card `ac90ca8e`) asserts "`~/` expands to the engine's homedir" — read literally, that's the OS
home directory, not the relocated config home.

**The fix is robust under either interpretation**: `transcriptRootReadDenyRules()`/
`otherProjectTranscriptDenyRules()` now emit the EXISTING home-relative rule unconditionally (byte-identical
argv when `CLAUDE_CONFIG_DIR` is unset), PLUS — only when `CLAUDE_CONFIG_DIR` is set — an ADDITIONAL
absolute-path rule built from `claudeConfigHome()`. Both apply, so the deny holds whichever way the CLI
expands `~/`.

### Absolute-path rule syntax in a `Read()` rule

Reused `pty/loom-home-deny.ts`'s existing `toClaudeAbsoluteGlob` helper rather than inventing a second
absolute-path transform — it already emits the CLI's documented universal-absolute glob form (`//<path>`
on POSIX, `//<drive-letter>/<rest>` on Windows, lowercase drive, no colon), and that exact form was
ALREADY real-spawn-verified for an `Edit()` rule, **on WINDOWS ONLY**
(`docs/decisions/37310431-loom-home-write-deny.md`, "Ruling A"). That same record's own Ruling A section
states POSIX verification was explicitly OUT of scope for card `37310431` — "nothing here was ever
measured against a real POSIX host" — so the claim below must not be read as "verified cross-platform";
it is a Windows-only data point, carried forward here unchanged rather than widened.

**Residual, disclosed rather than assumed**: that real-spawn verification covered `Edit()`, not `Read()`.
Static scanning of the bundle found a `^(\\\\|\/\/)` absolute-path-detection regex (byte offset ~164059574,
next to a "gitignore-style pattern is unusable" warning), consistent with the same universal-absolute
convention, but could not be conclusively traced to the `Read()`/`Edit()` permission.deny parser
specifically rather than a different settings surface (possibly the newer OS-level sandbox's
`filesystem.denyRead` path-form matcher). The choice to reuse `toClaudeAbsoluteGlob` here is a deliberate
generalization from the one case that WAS real-spawn-verified (every `ToolName(<pattern>)` deny-rule entry
is reasoned to share one grammar for its path portion, regardless of which tool the rule names), not a
second independent verification. A dedicated real-spawn test of an absolute-path `Read()` rule would close
this residual; not built here.

**Round 2 re-attempt (card `a92a0913`, time-boxed ~20min, static only — never ran `claude`), STILL
UNCONFIRMED, one negative finding added:** re-verified against the SAME installed CLI build
(`VERSION:"2.1.317"`, `BUILD_TIME:"2026-11-02T22:15:13Z"`, read from the bundle's own embedded constants
at byte offset ~283414728 — the exe's mtime of 2026-11-03 ~02:30 did not change the version). Traced the
`^(\\\\|\/\/)` regex's surrounding code (its full context block, "skipped by the ignore library (blank,
comment, or trailing backslash)" / "treating it as matching nothing" / `tengu_uncompilable_ignore_pattern`)
and confirmed it belongs to the gitignore-STYLE IGNORE-FILE pattern validator (the `.gitignore`/
`.claudeignore`-shaped allow/deny-file parser), not the `permission.deny` `Read()`/`Edit()` rule matcher —
a NEGATIVE finding that narrows, but does not resolve, the open question (it rules out this specific regex
as the mechanism, where round 1 could only say "not confirmed either way"). Also found, and ruled OUT as
unrelated: a `Lcs(n)` tilde-detection helper (`e==="~"||e.startsWith("~/")`) feeding `--add-dir`/settings
path resolution (`UOt`'s `addDir` mapping) — a DIFFERENT surface (CLI argument/settings-file path
normalization), not the permission-rule parser either. Could not locate the actual `Read()`/`Edit()`
permission.deny parser's own absolute-path-expansion branch by static string/identifier search within the
time-box — the settings-validation error text (byte offset ~157505415) confirms the DOCUMENTED rule syntax
(`["Bash(npm run build)", "Edit(docs/**)", "Read(~/.zshrc)"]`) but not its runtime parser's own code.
**Still a named residual** — unchanged from round 1's own conclusion, now with two additional ruled-out
candidates. A dedicated real-spawn test remains the only way to close it.

**Round 3 (card `a92a0913`, Code Review fix): a THIRD rule form added, win32 only — the plain
forward-slashed drive-letter form (`Read(C:/…/**)`), never a replacement for the `//c/…` one.** Unlike
the `//c/…` form (real-spawn-verified only for `Edit()`, per Ruling A above), the PLAIN form is already
live-verified as honoured for `Read()` itself, on Windows, by a DIFFERENT card's own Code Review:
`docs/decisions/ed0757d6-mcp-config-secret-file-lifecycle.md` (~L87-101, "What Code Review actually verified
LIVE (claude 2.1.285)") states plainly that "the SETTINGS_DIR deny is honoured for `Read` and for
`Bash(cat)`" — and `SETTINGS_DIR_READ_DENY_RULE` (`pty/claude-settings.ts:433`) is built with exactly
this plain transform: `` `Read(${SETTINGS_DIR.replace(/\\/g, "/")}/**)` ``, no `//` prefix, no drive-
letter lowercasing. So between the two absolute forms this file's transcript-root deny can emit, the
plain one — not the `//c/…` one — is the one with actual `Read()`-specific live evidence behind it.
Emitting BOTH (deny rules only ever add, never narrow) covers whichever one the real `Read()` permission
parser actually honours for this specific root, without having to resolve the still-open residual above.
`claudeProjectsRootPlainSlashedGlob()` (`claude-transcript.ts`) is the new helper; no POSIX sibling is
added — POSIX has no second, unambiguous absolute form to add. `toClaudeAbsoluteGlob`'s POSIX branch
prepends ONE extra leading slash to the already-absolute path (`/home/…` → `//home/…`), the same
double-slash disambiguation win32's `//c/…` form uses; a BARE single-leading-slash POSIX path (`/home/…`,
unchanged) is, by that same convention, SETTINGS-RELATIVE, not absolute — so it is the POSIX analogue of
win32's plain `C:/…` form only in shape, not in effect: emitting it would add a rule that never matches
as absolute, not a genuine second candidate. `toClaudeAbsoluteGlob`'s own (double-slash) output stays the
only absolute-glob form this guard emits on POSIX. The unset-`CLAUDE_CONFIG_DIR` shape is unaffected
(both new-sibling pushes are gated on `CLAUDE_CONFIG_DIR` being set, same as the `//c/…` sibling already
was).

## Source

Investigation + implementation: the worker's `worker_report` history on card `a92a0913`. Implementation:
`packages/daemon/src/pty/claude-config.ts` (`claudeConfigHome`), `packages/daemon/src/pty/
claude-transcript.ts` (`engineTranscriptPath`, `claudeProjectsRoot`, `transcriptRootReadDenyRules`,
`otherProjectTranscriptDenyRules`), `packages/daemon/src/pty/host.ts` (`withTranscriptRootDenyForSpawn`).
Tests: `packages/daemon/test/claude-config.mjs`, `packages/daemon/test/transcript-root-deny-chokepoint.mjs`,
`packages/daemon/test/transcript-realhome-sandbox-guard.mjs` (card `668bc52c`'s own guard, extended).
