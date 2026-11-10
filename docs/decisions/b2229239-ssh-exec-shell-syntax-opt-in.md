# b2229239 — `ssh_exec` accepts quoted and piped commands only on a connection the owner opted in

## Why

`ssh_exec` used to refuse every quote, pipe, `;` and `$` (`SHELL_METACHARS` in `connections/sshPolicy.ts`). Real operations (`pct exec`, `vzdump`, editing fstab) need quoted arguments and pipes, so an operator drove the PVE host through raw Bash `ssh` instead. That work ran with no risky-command hold and no Loom audit row. The point of this change is to make the guarded path usable so the unguarded one is not the easy one, without weakening the guard.

## What is allowed now

A per-connection, human-only `shellSyntax` flag (default OFF, column `ssh_shell_syntax`, REST `POST /api/connections/ssh` and `PUT /api/connections/:id/ssh`, Connections form checkbox; no MCP tool writes it). With it ON and `readOnly` OFF, `ssh_exec` accepts a closed grammar, parsed by `connections/sshShellParse.ts`:

- `|` is the ONLY operator. `||` and an empty stage are refused.
- A word is an unquoted run of `[A-Za-z0-9_./:=@%+,-]` (not starting with `=`), `'single'` and `"double"` pieces glued together.
- Everything else is refused with the same `shell-metacharacters` reason as before: `;`, `&` (so `&&`, `||`, background), `$` anywhere (so `$(…)`, `${…}`, `$VAR`), backticks, `<` `>` and here-docs, `( )` `{ }`, backslash, `* ? [ ]`, `~`, `#`, `!`, `^`, and any unterminated quote. `$`, backtick and backslash are refused even inside single quotes (fail closed; the remote shell would treat them as literal there).
- Newlines, control characters and non-ASCII are refused by the existing gates before the grammar runs.

Because the grammar has no expansion, substitution, redirection, grouping, escaping or globbing, de-quoting by this parser and by the remote shell produce the same words. That equivalence covers the OUTER command line only. It does NOT by itself make shell mode sound: a program can take text from stdin or an argument and evaluate it as code, and nothing in the outer line shows that. See "Soundness argument" below for what actually carries the claim.

## How every stage reaches the risky screen

- Each pipeline stage's de-quoted words are matched against the risky list separately (`riskyWordMatch`, unchanged: any word position, basename-folded, case-insensitive, option-skipping). A word holding characters outside the plain charset (a quoted payload such as `'rm -rf /x'`) is also split into pieces right after itself, so a risky command hidden in a quoted string is still seen. `exact` rules still compare the whole text; `regex` rules still run once over the whole text in the bounded worker.
- Wrappers that run their argument are covered two ways. The transparent ones (`sudo`, `env`, `nice`, `FOO=1`, absolute paths) are seen by the any-position match. Anything that executes a string, stdin or another program is a **hold regardless of the risky list** (`shellExecutorHold`): shells (`sh bash zsh dash ksh fish csh tcsh ash busybox rbash`), interpreters (`python* perl ruby node php lua awk gawk mawk tclsh pwsh …`), `xargs`, `eval`, `su`, `watch`, `nsenter`, `chroot`, `ssh`, `pct`, `qm`, `lxc`, `kubectl`, `docker`/`podman` `exec`/`run`, and `find -exec/-execdir/-ok/-okdir`. A pipe into a shell or interpreter executes stdin, so it is held even without `-c`/`-e`. This over-matches on purpose (any word position, so `grep sh /etc/passwd` is held): a false hold costs the owner one click, a miss costs a remote shell.
- **Round 2 — "no de-quoted word may carry shell syntax" (one of three parts of the soundness argument below, not the whole of it).** In shell mode a command is HELD (whatever the risky list says) when any de-quoted word still contains a character of the old flat-grammar set (quotes, `; & | < > ( ) { } * ? [ ] ~ # ! ^`): after de-quoting such a word is only meaningful as a payload for a nested evaluator. This costs deliberate false holds (`sed -i 's|a|b|' f`, `grep -v '^#' f`, `find … '{}'`). `shellExecutorHold` also runs over the PIECES of each quoted word (so a shell named inside `env -S 'sh -c …'` is seen), and the string/stdin evaluators are held in any position: `.` (command position, after `NAME=` prefixes), `source`, `at`, `batch`, `crontab`, `trap`, and `env` with `-S`/`--split-string` in any spelling. An owner `exact` risky rule also matches each segment's de-quoted words joined by single spaces (`systemctl restart 'nginx'` matches `exact:"systemctl restart nginx"`); shell mode only, the OFF path is unchanged. Known and filed separately, not fixed here: splitting risky pieces on `=` (`git -c core.sshCommand=reboot`, `GIT_SSH_COMMAND=reboot`), and whether `tee`/`sed -i` join the default risky list.
- **Round 3 — stdin-fed nested evaluators.** A pipeline can decode a payload at runtime and feed it to an evaluator with NO syntax in any word (`echo <hex> | xxd -r -p | command . /dev/stdin`, `… | sed e`, `… | sudo -s`, `… | make -f -`, `| m4`, `| sqlite3`). The evaluator set is open-ended, so the rules fail closed instead of enumerating evaluators (a hold costs one approval click):
  - **R6 pipeline-stage filter allowlist.** Every stage after the first is HELD unless its command word (de-quoted, matched CASE-SENSITIVELY, R16: `| CAT` and `| /usr/bin/WC` are held) is one of `wc head tail cut tr uniq sort grep egrep fgrep cat nl column` (`PIPELINE_FILTERS`, a code constant, not owner-configurable) AND is written as a bare name or under a standard bin dir (R13, round 4). `awk sed xargs tee jq less` are deliberately absent. An allowed stage's words still go through every other check. The `sort`/`uniq` quirks that make two of those filters write files or run programs are handled by R15 (sort) and R11 (uniq), not by the list.
  - **R7 command-position wrapper normalization.** Before the command-position check (`.`), leading `NAME=value` words and the wrappers `command builtin time nohup exec nice stdbuf timeout ionice sudo doas` are stripped together with their options (`normalizeCommandPosition`), so `command . x`, `time . x`, `nice -n 5 . x`, `sudo -u root . x` are seen as `.`. Each wrapper has a closed option table; an option it does not name is unparsable and HELD. `sudo`/`doas` with `-s`/`-i`/`-e` (or `--shell`/`--login`/`--edit`) is HELD at command position of any segment (`su` is already an executor hold).
  - **R8 `sed`** (tightened by R12, round 4; `gsed` and `ssed` get the same rule, R17). Every `sed` word at any position is HELD unless the words after it satisfy ALL of: every word starting with `-`, at ANY position, is one of `-n -E -r -s -z` (or the `--` terminator, after which every word is a file); the first non-option word is exactly one plain program, `s/RE/REPL/[gpiI0-9]*` or `N[,M]p`; every other word is a non-option file word (not itself program-shaped). GNU sed permutes its arguments, so checking only the first word missed `sed s/x/x/ -e 1ereboot f`. This holds `-e`, `-f`, `-i`, `--expression` wherever they sit, and any program with an `e`/`w` flag or command, without parsing sed. The cost is false holds such as `sed -i s/a/b/ f`.
  - **R9.** One exported constant, `SHELL_SYNTAX_CHARS` (`sshShellParse.ts`), is both the flat grammar's refusal set (`sshPolicy.ts` `SHELL_METACHARS`) and the de-quoted-word check, so the two cannot drift.
- **Round 4 — filter quirks and paths.** The round-3 review found that two list members are not inert:
  - **R11 output sinks.** `sort -o FILE`/`--output=FILE` and `uniq - OUTFILE` write the piped payload to an arbitrary path (a cron.d file). At ANY word position of ANY segment (so `setsid sort …` and a quoted `'sort -o x'` are seen too). The round-4 `sort` DENYLIST (`-o`, `--o…`, `--c…`, `--files0-from`) was retired in round 5: it missed `sort -T DIR`/`--temporary-directory=DIR` (spill files land in DIR; `yes '… root reb'X'oot' | tr -d X | sort -S 1K -T /etc/cron.d`), the third sort sink found by enumeration. **R15** replaced it with a POSITIVE allowlist: `sort` is allowed only when every option word (before any `--`) is a bundle of `-bdfghiMnrsuVz` letters only, `-k KEYDEF`/`-t SEP` (attached or separate), or one of the exact long spellings `--ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --human-numeric-sort --ignore-nonprinting --month-sort --numeric-sort --reverse --stable --unique --version-sort --zero-terminated --key=… --field-separator=…` (no abbreviations). Everything else (`-S -T -o -m -c -C -R`, `--random-source --parallel --batch-size`, any abbreviation) is HELD. The bundled/attached `-to` is an accepted false hold. `uniq` is HELD with ANY non-option word other than a pure-digit argument to `-f`/`-s`/`-w` (attached, or the next word after an option word ending in one of them): `uniq -c`/`-d` stay clean, `uniq --skip-fields 1` is a deliberate false hold. The OFF path is unchanged; pipe-free `sort -o x` is allowed there as before, since these are shell-mode holds only.
  - **R12** — the sed rule above.
  - **R13 filter path.** A filter stage is allowed only as a bare name or under `/bin /usr/bin /usr/local/bin /sbin /usr/sbin /usr/local/sbin` (`FILTER_BIN_DIRS`). Folding any path to its basename on an allow list fails open (`| /tmp/x/cat` could be a renamed `sqlite3`).
- The held command still goes through the existing owner approval of that exact text. A hold never widens a read-only connection or an allowlist.
- The recursive parse of an `sh -c '…'` payload that was discussed was not built: the hold is already unconditional for those forms, so a recursive parse could only produce the same hold.

## Soundness argument

Shell mode is sound only as the conjunction of three parts (an earlier draft claimed the first alone was enough; the round-2 review disproved that):

1. **No syntax in words.** The closed grammar plus "no de-quoted word carries shell syntax" means the outer line is parsed identically here and on the remote shell, and no quoted payload for a second parser survives into a word.
2. **A pipeline-stage filter list (R6).** The only way text reaches an evaluator without appearing as syntax is stdin, which needs a pipe; every later stage must be a known filter that does not evaluate its input.
3. **Command-position normalization (R7, plus R8 for sed).** The first stage cannot hide `.`/`sudo -s` behind a transparent wrapper, and `sed`, which can execute text, is held unless its program is plain.

On top of that the executor/interpreter hold and the risky word screen apply. What is deliberately NOT claimed: that the screen recognises every program that evaluates its argument.

**Residuals (named, not fixed here):**

- **`=`-glued payloads** (`git -c 'core.pager=…'`, `GIT_SSH_COMMAND='…'`, `tar -I`, `rsync -e` with a value glued by `=`): the risky screen does not split words on `=`, so the payload after it is not seen as a command. Tracked as card `7755b0bd`.
- A first-stage program that evaluates its own ARGUMENTS and is on no list (`make -f x`, `m4 x`, `sqlite3 db .shell`): only the risky list and the server-side user constrain it.
- Filter stages with a quirk not yet known to write or evaluate: `sort` (R15: positive option allowlist), `uniq` (R11: output operand) and `sed` (R12, not a filter) are the ones found and handled; the list is a judgement, revisit it when another filter is found to write a file or execute.
- **A risky word inside a `/`-terminated word** (`s/a/reboot/` folds to an empty basename, so the risky screen never sees `reboot`). This predates this card and affects the OFF path as well; it is its own card (`7eea8cd4`) and is not fixed here.
- The remote login shell is assumed POSIX (the owner's attestation).

## Allowlist

With a non-empty allowlist, a multi-stage pipeline passes only if the owner's `exact` rule equals the whole text, or EVERY stage matches an `exact`/`prefix` rule on its own raw text. A `regex` allowlist rule cannot qualify a multi-stage command (`^ls.*` would swallow a piped tail); a single-stage command is evaluated exactly as before.

## What does not change

- The read-only verb list and `isReadOnlyCommand` are untouched. A read-only connection keeps the flat grammar: `shellSyntax` is inert on it (policy) and refused with it (store validation: `shellSyntax` requires `readOnly:false`).
- Default OFF is byte-identical to before: a pre-existing row backfills `ssh_shell_syntax` to 0 and still refuses every quote and pipe.
- No new MCP tool, no new grant path. The flag is human-only REST like `readOnly`, `commandAllowlist` and `riskyCommandPatterns`; the agent-facing surface only gets a longer `ssh_exec` description.

## Known limits (the owner's attestation, not detected)

- The soundness argument assumes the remote **login shell is POSIX sh-compatible**. A non-POSIX shell (fish, PowerShell over Windows OpenSSH, rbash, zsh with extra expansions) can de-quote differently. Ticking the opt-in is the owner's statement that the host's shell is sh/bash-compatible; Loom does not probe for it. The UI label and REST text say so.
- The risky screen is still a word screen, not a boundary: a binary or script not on the list, a program run by a script, or an alias is not recognised. The real boundary remains the server-side least-privileged user.
- A local script or binary as the FIRST stage (`./deploy | wc`) is not held by this mechanism; only the owner's risky list and the server-side user constrain it. As a LATER stage (`… | ./deploy`) it is held (R6 + R13: not a filter, and a path outside the standard bin dirs).

## Do not

- Do not widen the grammar by refusing less: add one character to one rule with its own mutation test. Never accept `;`, `&`, `$`, backtick, redirection, grouping, backslash or globs "because they are inside quotes".
- Do not honour `shellSyntax` on a `readOnly` connection, and do not give an agent any path to set it.
- Do not match the risky list against the whole pipeline text only: every stage is screened on its own words.
- Do not make a shell/interpreter/xargs/`find -exec` word depend on the risky list for its hold.
- Do not relax "no de-quoted word may carry shell syntax" (round 2). The parser's equivalence with the remote shell covers the OUTER command line only; a quoted argument that a SECOND evaluator parses (`trap`, `env -S`, `sed 'e'`, `git -c alias.x=!`, `tar -I`, `rsync -e`, `GIT_SSH_COMMAND`) is re-parsed there, and nested quoting (`r""eboot`) hides a risky word from the word screen. Do not "fix" a false hold such as `sed -i 's|a|b|' f` by allowing metacharacters in de-quoted words: a false hold is one approval click, a false allow is remote code.
- Do not drop the executor check over the pieces of a quoted word, or shrink the string/stdin evaluator list (`.`, `source`, `at`, `batch`, `crontab`, `trap`, `env -S`/`--split-string`).
- Do not add `awk`, `sed`, `xargs`, `tee`, `jq` or `less` (or any program that can run text it reads) to `PIPELINE_FILTERS`, do not relax R11/R15 (`sort`/`uniq` are on the list only because their file-writing and program-running forms are held), do not fold a filter path to its basename (R13), and do not replace the filter list with an enumeration of stdin evaluators: that set is open-ended.
- Do not screen a write-capable program by enumerating its dangerous options (the `sort` denylist missed `-T` after `-o`/`--compress-program`: three sinks found one review at a time). Allow-list its safe options and HOLD the rest. Do not case-fold the filter-name match (R16).
- Do not claim the closed grammar or the de-quoted-word rule alone makes shell mode sound; it is the three-part argument above.
- Do not keep two copies of the shell-syntax character set; `SHELL_SYNTAX_CHARS` is the only one.
- Do not let a regex allowlist rule qualify a multi-stage pipeline.
- Do not try to detect the remote login shell; the opt-in is an attestation.
