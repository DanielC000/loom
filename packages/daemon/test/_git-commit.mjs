// SHARED TEST HELPER — commitAll(cwd, messages, identity?)
//
// WHY THIS EXISTS (card 0abfc9be): 217 files / 570 callsites in this suite ran the fixture-setup shape
// `git add . && git ... commit -q -m "..."` as ONE execSync shell chain. When that chain fails,
// execSync's "Command failed:" error names the WHOLE chain — it is structurally incapable of saying
// whether `git add` or `git commit` failed. Two real specimens (gate op 849d955a / merge aa93f387;
// worker-spawn-shipped-match.mjs, merge-canonical-dirty-overlap-backstop.mjs:148) were ambiguous by
// construction: both empty stdout, CRLF-advisory-only stderr, no `fatal:` line to hint which half broke.
// This helper runs `git add .` and `git commit` as TWO separate execFileSync calls, each throwing an
// error that NAMES which command failed plus that command's own captured stdout/stderr.
//
// execFileSync (argv array, no shell) is used instead of execSync (shell string) so there is no shell
// quoting to reproduce for a message containing spaces/quotes — the message is passed as a literal argv
// element, never interpolated into a command string. Node's execFileSync shares the exact same internal
// checkExecSyncError() path as execSync (verified empirically, card 0abfc9be), so a failure's thrown
// Error.message still carries the subprocess's stderr appended — the CRLF advisories that identified both
// real specimens survive unchanged; this helper does not swallow or silence stderr anywhere.
//
// `identity` is OPTIONAL and PASSED THROUGH ABSENT WHEN ABSENT. 8 of the 570 original callsites relied on
// ambient/pre-configured git identity and committed with NO `-c user.email=`/`-c user.name=` flags at all
// — injecting a default here would silently change which committer those 8 sites' commits are recorded
// under (this repo has its own git-identity-warning.mjs test whose whole subject is committer identity).
// Pass the exact identity string used at the original callsite (e.g. "-c user.email=x@loom -c
// user.name=x", or a file's own `${GIT_ID}` const holding that same shape) — never invent one when the
// original site had none.
//
// A caller whose original chain also ran `git init` / `git config user.email` / `git config user.name`
// keeps that prefix as its OWN separate execSync/execFileSync call before calling commitAll — that prefix
// is not part of the ambiguous add-vs-commit race this card exists to disambiguate, and splitting it out
// further is out of this card's scope.
import { execFileSync } from "node:child_process";

function describeFailure(err) {
  const stdout = err.stdout ? err.stdout.toString() : "";
  const stderr = err.stderr ? err.stderr.toString() : "";
  return `stdout (${stdout.length}B): ${JSON.stringify(stdout)}\nstderr (${stderr.length}B): ${JSON.stringify(stderr)}`;
}

/**
 * @param {string} cwd
 * @param {string|string[]} messages  one or more `-m` message(s), in order
 * @param {string} [identity]  e.g. "-c user.email=x@loom -c user.name=x" — omit to commit with no
 *   identity flags (relies on ambient/pre-configured git identity), matching the original callsite.
 */
export function commitAll(cwd, messages, identity) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  const idArgs = identity ? identity.split(" ").filter(Boolean) : [];

  try {
    execFileSync("git", ["add", "."], { cwd });
  } catch (err) {
    throw new Error(`commitAll: 'git add .' failed in ${cwd}\n${describeFailure(err)}`);
  }

  const msgArgs = msgs.flatMap((m) => ["-m", m]);
  try {
    execFileSync("git", [...idArgs, "commit", "-q", ...msgArgs], { cwd });
  } catch (err) {
    throw new Error(`commitAll: 'git commit' failed in ${cwd}\n${describeFailure(err)}`);
  }
}
