# 8d0ba38b — absolute-path permission deny rules use the documented `//` form, through one helper

## MEASURED (WSL Ubuntu-22.04, claude 2.1.323, `claude -p` used for the permission measurement only)

A `--settings` file in a directory DIFFERENT from the target; `--allowedTools <tool>`; deny must beat allow.

| rule | Read of the target | Write of a new file in the target |
|---|---|---|
| none (control) | allowed | allowed |
| single slash `Read(/home/u/t/**)` / `Edit(/home/u/t/**)` | **allowed (inert)** | **allowed (inert)** |
| `//` form `Read(//home/u/t/**)` / `Edit(//home/u/t/**)` | denied | denied (file absent) |
| home-relative `Read(~/t/**)` and `Read(~/t/*-x-*/**)` (mid-segment wildcard) | denied | not measured |

`Write(...)` is not a recognized rule name (card 37310431); the Write rows used `Edit(...)`. The `~/` rows
mean the `~/.claude/projects/...` transcript rules are fine on POSIX and were left alone.

## Decision

`pty/permission-rules.ts` is the one place an absolute path becomes a rule: `toClaudeAbsoluteGlob`,
`claudeAbsoluteGlobForms`, `claudeAbsoluteRules`. POSIX emits only `//<path>`; win32 emits `//c/...` AND the
plain `C:/...` form (the form measured working on Windows before the documented form was adopted).
Users: `SETTINGS_DIR_READ_DENY_RULE(S)` (`claude-settings.ts`), the CLAUDE_CONFIG_DIR transcript siblings
(`claude-transcript.ts`), the LOOM_HOME `Edit()` rules (`loom-home-deny.ts`).

## Shipped-inert history

`SETTINGS_DIR_READ_DENY_RULE` (single-slash) first landed in commit `38ec2706` (2026-09-30), first contained
in release **v0.31.0** (2026-10-13; v0.30.0 does not contain it). Releases v0.31.0 and v0.32.0 shipped the
settings-dir read deny INERT on Linux/macOS; the junction-alias variant (`c2b42187`, 2026-10-07) shipped in
the same releases. The transcript-root rules are `~/`-form and were never inert. On Windows the `C:/` form
was measured working, so Windows was not affected. Whether a later release carries this fix is a release-cut
fact, not recorded here.

UNC and `\\?\` paths for `SETTINGS_DIR` and `LOOM_HOME_REAL` are unmeasured (same as before this card).

## Do not

- Do not hand-build `Read(${absPath}/**)` / `Edit(${absPath})`; a single leading slash anchors at the
  settings file's directory and matches nothing real on POSIX. Use `claudeAbsoluteRules`.
- Do not drop the win32 plain `C:/` sibling without re-measuring on Windows.
- Do not generalise the WSL result past claude 2.1.323; re-measure after a CLI upgrade.
- Do not claim the settings-dir deny closes Bash/subprocess reads (see `ed0757d6`/`f2bb9dbe`).
