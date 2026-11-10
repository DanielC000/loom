/**
 * The closed shell-syntax grammar `ssh_exec` accepts on a connection whose owner opted into `shellSyntax`.
 *
 * Grammar (printable ASCII only; anything not named here is REFUSED, never interpreted):
 *   command  := segment ( '|' segment )*          -- `|` is the ONLY operator; `||` leaves an empty segment
 *   segment  := word+                             -- a segment must be non-empty
 *   word     := ( unquoted | 'single' | "double" )+   -- adjacent pieces glue into ONE word, as in POSIX sh
 *   unquoted := [A-Za-z0-9_./:=@%+,-]+            -- a word may not START with `=` (zsh `=cmd` expansion)
 *   'single' := any printable ASCII except ' $ ` \
 *   "double" := any printable ASCII except " $ ` \ !
 * Words are separated by spaces. There is no expansion, substitution, redirection, grouping, escaping,
 * globbing, job control or comment syntax in this grammar, so the remote POSIX shell de-quotes a word exactly
 * the way this parser does. That equivalence covers the OUTER line only (the full three-part soundness argument,
 * incl. the pipeline-stage filter list and command-position normalization, is in the decision record); it assumes the remote LOGIN
 * shell is POSIX sh-compatible, which is the owner's attestation when they tick the opt-in (never detected).
 *
 * @decision b2229239 — keep this a closed grammar: widen it only by adding a character to a rule above with a
 * mutation test, never by refusing less. `$` and backslash stay refused even inside single quotes.
 */

export type SshShellParseResult =
  | { ok: true; segments: ParsedSegment[] }
  | { ok: false };

export interface ParsedSegment {
  /** The segment's de-quoted argv words, in order. */
  words: string[];
  /** The segment's raw source text (trimmed), for per-segment allowlist prefix/exact matching. */
  raw: string;
}

// THE plain-word charset, written once (the header grammar's `unquoted` rule); the three regexes derive from it.
const PLAIN_WORD_CHARS = "A-Za-z0-9_./:=@%+,-";
const UNQUOTED_OK = new RegExp(`[${PLAIN_WORD_CHARS}]`);
const NON_PLAIN_CHAR = new RegExp(`[^${PLAIN_WORD_CHARS}]`);
const NON_PLAIN_RUN = new RegExp(`[^${PLAIN_WORD_CHARS}]+`);
const SINGLE_QUOTED_BAD = /['$`\\]/;
const DOUBLE_QUOTED_BAD = /["$`\\!]/;

export function parseSshShellCommand(command: string): SshShellParseResult {
  const segments: ParsedSegment[] = [];
  let words: string[] = [];
  let segStart = 0;
  let cur = "";
  let inWord = false;
  const endWord = (): void => { if (inWord) { words.push(cur); cur = ""; inWord = false; } };
  const endSegment = (end: number): boolean => {
    endWord();
    if (words.length === 0) return false;
    segments.push({ words, raw: command.slice(segStart, end).trim() });
    words = [];
    return true;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === " ") { endWord(); i++; continue; }
    if (ch === "|") {
      if (!endSegment(i)) return { ok: false };
      segStart = i + 1;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const bad = ch === "'" ? SINGLE_QUOTED_BAD : DOUBLE_QUOTED_BAD;
      let j = i + 1;
      let body = "";
      for (;;) {
        if (j >= command.length) return { ok: false }; // unterminated quote
        const c = command[j]!;
        if (c === ch) break;
        if (bad.test(c)) return { ok: false };
        body += c;
        j++;
      }
      cur += body;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (!UNQUOTED_OK.test(ch)) return { ok: false };
    if (ch === "=" && !inWord) return { ok: false };
    cur += ch;
    inWord = true;
    i++;
  }
  if (!endSegment(command.length)) return { ok: false };
  return { ok: true, segments };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "ash", "busybox", "rbash"]);
const INTERPRETER_RE = /^(python[0-9.]*|perl[0-9.]*|ruby[0-9.]*|node|nodejs|php[0-9.]*|lua[0-9.]*|awk|gawk|mawk|nawk|tclsh|osascript|pwsh|powershell)$/;
/** Programs that run another program (or a string as a program) named in their own arguments. */
const EXECUTORS = new Set([
  "xargs", "eval", "exec", "su", "watch", "nsenter", "chroot", "ssh", "pct", "qm", "lxc", "lxc-attach", "kubectl",
  "parallel", "script", "flock", "unshare", "runuser", "setpriv",
]);
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const base = (w: string): string => {
  const i = w.lastIndexOf("/");
  return (i >= 0 ? w.slice(i + 1) : w).toLowerCase();
};

/**
 * Does any segment contain a word that executes another program or a string/stdin as a program? A hit is a
 * HOLD (owner approval of the exact text) whatever the risky list says: the risky word screen cannot see
 * through `sh -c '...'`, `xargs rm`, `find -exec` or a pipe into an interpreter (which executes stdin).
 * Deliberately OVER-matches: any word position, basename-folded, case-insensitive (so `grep python` holds).
 * `docker` is held only for `exec`/`run`/`compose`-style subcommands that run a command in a container.
 */
export function shellExecutorHold(segments: ParsedSegment[]): boolean {
  for (const seg of segments) {
    // The whole de-quoted words AND the pieces of any word carrying non-plain characters: a shell named
    // INSIDE a quoted word (`env -S 'sh -c ...'`) is a second evaluator's payload.
    const ws = wordsForRiskyMatch(seg.words);
    const folded = ws.map(base);
    for (let k = 0; k < folded.length; k++) {
      const w = folded[k]!;
      if (SHELLS.has(w) || INTERPRETER_RE.test(w) || EXECUTORS.has(w) || STRING_EVALUATORS.has(w)) return true;
      if (FIND_EXEC_FLAGS.has(ws[k]!.toLowerCase())) return true;
      if ((w === "docker" || w === "podman") && folded.slice(k + 1).some((x) => x === "exec" || x === "run")) return true;
      // `env -S` / `env --split-string[=…]` re-parses its argument as a command line (any spelling).
      if (w === "env" && ws.slice(k + 1).some((x) => /^-[A-Za-z0-9]*S/.test(x) || /^--s[a-z-]*(=|$)/.test(x))) return true;
    }
    // Command-position checks run on the NORMALIZED command (leading wrappers stripped), so `command . x`,
    // `time . x` and `sudo -s` are seen as what they run.
    if (commandPositionHold(seg.words)) return true;
    if (sedHold(seg.words)) return true;
    // sort/uniq option parsing needs the option words intact, so it gets the list WITHOUT the glued pieces.
    if (filterSinkHold(wordsForRiskyMatch(seg.words, false))) return true;
  }
  return pipelineStageHold(segments);
}

// ---- R6: pipeline-stage filter allowlist -----------------------------------------------------------------
// A stage after the first reads the previous stage's output on stdin, and the set of programs that evaluate
// stdin (`xxd -r -p | command . /dev/stdin`, `| make -f -`, `| m4`, `| sqlite3`, `| sed e`) is open-ended, so in
// shell mode every later stage is HELD unless its command word is one of these fixed filters. The words of an
// allowed stage still go through every other check. Deliberately absent: awk sed xargs tee jq less.
const PIPELINE_FILTERS = new Set(["wc", "head", "tail", "cut", "tr", "uniq", "sort", "grep", "egrep", "fgrep", "cat", "nl", "column"]);

// R13: a filter is recognised only as a BARE name or under one of these standard bin dirs. Folding any path to
// its basename on an ALLOW list fails open (`| /tmp/x/cat` could be a renamed evaluator).
const FILTER_BIN_DIRS = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin", "/usr/local/sbin"]);

// R16: the name match is CASE-SENSITIVE (no folding): `| CAT` and `| /usr/bin/WC` are HELD, since a case-folding
// filesystem or a renamed binary would otherwise run something other than the filter the allowlist meant.
function isAllowedFilterWord(cmd: string): boolean {
  const i = cmd.lastIndexOf("/");
  if (i >= 0 && !FILTER_BIN_DIRS.has(cmd.slice(0, i))) return false;
  return PIPELINE_FILTERS.has(i >= 0 ? cmd.slice(i + 1) : cmd);
}

function pipelineStageHold(segments: ParsedSegment[]): boolean {
  for (let s = 1; s < segments.length; s++) {
    const cmd = segments[s]!.words[0];
    if (cmd === undefined || !isAllowedFilterWord(cmd)) return true;
  }
  for (const seg of segments) {
    if (normalizeCommandPosition(seg.words).hold) return true;
  }
  return false;
}

// ---- R11: filter output sinks ------------------------------------------------------------------------------
// `sort` and `uniq` can WRITE their (piped) input to an arbitrary path, and `sort` can run a program. Both are
// checked at ANY word position of ANY segment (so `setsid sort -o x` and a quoted `'sort -o x'` are seen too).

/** R15 — `sort` is screened by a POSITIVE option allowlist, never by listing dangerous options (`-o`, `-T`,
 *  `--compress-program`, `-S` spill files ... the denylist missed a sink three times). Allowed: bundled
 *  `-bdfghiMnrsuVz` letters; `-k KEYDEF` / `-t SEP` (attached or separate); `--` (then only files); the exact
 *  long spellings below (no abbreviations, `--key=`/`--field-separator=` need their `=`). Anything else HOLDS.
 *  The bundled/attached `-to` is an accepted false hold (an attached `-t` separator must not be `o`). */
const SORT_PLAIN_BUNDLE = /^-[bdfghiMnrsuVz]+$/;
const SORT_LONG_OK = new Set([
  "--ignore-leading-blanks", "--dictionary-order", "--ignore-case", "--general-numeric-sort", "--human-numeric-sort",
  "--ignore-nonprinting", "--month-sort", "--numeric-sort", "--reverse", "--stable", "--unique", "--version-sort",
  "--zero-terminated",
]);
function sortArgsHold(rest: string[]): boolean {
  let optionsDone = false;
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]!;
    if (optionsDone || w === "-" || !w.startsWith("-")) continue; // a file word (read, never written)
    if (w === "--") { optionsDone = true; continue; }
    if (w.startsWith("--")) {
      if (SORT_LONG_OK.has(w) || /^--key=.+/.test(w) || /^--field-separator=.+/.test(w)) continue;
      return true;
    }
    if (SORT_PLAIN_BUNDLE.test(w)) continue;
    if (w === "-k" || w === "-t") { k++; if (k >= rest.length) return true; continue; }
    if (/^-k.+/.test(w) || /^-t[^o]$/.test(w)) continue;
    return true;
  }
  return false;
}

/** `uniq`: its only OUTPUT sink is a second positional word (`uniq - OUTFILE`), so HOLD any non-option word other
 *  than a pure-digit argument to `-f`/`-s`/`-w` (attached, or as the next word after an option word ending in
 *  one of them). `uniq -c` and `uniq -d` stay clean; `uniq --skip-fields 1` is a deliberate false hold. */
function uniqOperandHold(rest: string[]): boolean {
  let expectDigits = false;
  for (const w of rest) {
    if (expectDigits) {
      expectDigits = false;
      if (/^[0-9]+$/.test(w)) continue;
    }
    if (w.length > 1 && w.startsWith("-") && w !== "--") {
      if (!w.startsWith("--") && /[fsw]$/.test(w)) expectDigits = true;
      continue;
    }
    return true;
  }
  return false;
}

function filterSinkHold(ws: string[]): boolean {
  for (let k = 0; k < ws.length; k++) {
    const b = base(ws[k]!);
    if (b === "sort" && sortArgsHold(ws.slice(k + 1))) return true;
    if (b === "uniq" && uniqOperandHold(ws.slice(k + 1))) return true;
  }
  return false;
}

// ---- R7: command-position wrapper normalization ----------------------------------------------------------
const NAME_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface WrapperSpec {
  shortArg: string; shortFlag: string; holdShort: string; digits?: boolean;
  longArg: string[]; longFlag: string[]; holdLong: string[]; positional?: number;
}
const NONE: WrapperSpec = { shortArg: "", shortFlag: "", holdShort: "", longArg: [], longFlag: [], holdLong: [] };
const SUDO_SPEC: WrapperSpec = {
  shortArg: "ugpCDrtTUh", shortFlag: "nEHkKbSAPBvlV", holdShort: "sie",
  longArg: ["user", "group", "host", "prompt", "close-from", "chdir", "role", "type", "command-timeout", "other-user"],
  longFlag: ["non-interactive", "set-home", "background", "stdin", "askpass", "reset-timestamp", "remove-timestamp", "validate", "list", "version", "preserve-env"],
  holdLong: ["shell", "login", "edit"],
};
// Wrappers that run the rest of their argv as a command. Any option the spec does not name is UNPARSABLE: HOLD.
const WRAPPERS: Record<string, WrapperSpec> = {
  command: { ...NONE, shortFlag: "pvV" },
  builtin: NONE,
  time: { ...NONE, shortFlag: "p" },
  nohup: NONE,
  exec: NONE,
  nice: { ...NONE, shortArg: "n", digits: true, longArg: ["adjustment"] },
  stdbuf: { ...NONE, shortArg: "ioe", longArg: ["input", "output", "error"] },
  timeout: { ...NONE, shortArg: "sk", shortFlag: "v", longArg: ["signal", "kill-after"], longFlag: ["foreground", "preserve-status", "verbose"], positional: 1 },
  ionice: { ...NONE, shortArg: "cn", shortFlag: "t", longArg: ["class", "classdata"], longFlag: ["ignore"] },
  sudo: SUDO_SPEC,
  doas: { ...NONE, shortArg: "uC", shortFlag: "nL", holdShort: "s" },
};

/** Index of the first word after a wrapper's options (and positionals), or -1 if they cannot be parsed. */
function skipWrapperOptions(spec: WrapperSpec, ws: string[], start: number): number {
  let i = start;
  while (i < ws.length) {
    const w = ws[i]!;
    if (w === "--") { i++; break; }
    if (!w.startsWith("-") || w === "-") break;
    if (w.startsWith("--")) {
      const name = w.slice(2).split("=")[0]!;
      const hasEq = w.includes("=");
      if (spec.holdLong.includes(name)) return -1;
      if (spec.longArg.includes(name)) { i += hasEq ? 1 : 2; continue; }
      if (spec.longFlag.includes(name) && !hasEq) { i++; continue; }
      return -1;
    }
    let consumedNext = false;
    for (let k = 1; k < w.length; k++) {
      const c = w[k]!;
      if (spec.holdShort.includes(c)) return -1;
      if (spec.shortArg.includes(c)) { consumedNext = k === w.length - 1; break; }
      if (spec.shortFlag.includes(c) || (spec.digits === true && /[0-9]/.test(c))) continue;
      return -1;
    }
    i += consumedNext ? 2 : 1;
  }
  return i + (spec.positional ?? 0);
}

/** The words of a segment after `NAME=value` prefixes and any number of leading wrappers (with their options)
 *  are stripped; `hold` when a wrapper's options cannot be parsed confidently, or for `sudo`/`doas` `-s`/`-i`. */
function normalizeCommandPosition(words: string[]): { rest: string[]; hold: boolean } {
  let i = 0;
  for (let depth = 0; depth < 8; depth++) {
    while (i < words.length && NAME_ASSIGN.test(words[i]!)) i++;
    const spec = i < words.length ? WRAPPERS[base(words[i]!)] : undefined;
    if (spec === undefined) return { rest: words.slice(i), hold: false };
    const next = skipWrapperOptions(spec, words, i + 1);
    if (next < 0) return { rest: [], hold: true };
    i = Math.min(next, words.length);
  }
  return { rest: [], hold: true }; // wrapper chain too deep to trust
}

/** `.` (the POSIX `source`) at the normalized command position, or an unparsable wrapper. */
function commandPositionHold(words: string[]): boolean {
  const { rest, hold } = normalizeCommandPosition(words);
  return hold || rest[0] === ".";
}

// ---- R8: sed --------------------------------------------------------------------------------------------
// GNU sed's `e` command / `s///e` flag execute text as a shell command. Rule (the simple one): every `sed`
// word, at ANY position, is HELD unless ALL of: every word starting with `-` (at ANY position — GNU sed permutes
// its arguments, so `sed s/x/x/ -e 1ereboot f` carries a second program after the first) is one of
// `-n -E -r -s -z` (or the `--` terminator, after which every word is a file); the first non-option word is
// ONE program of the plain form `s/RE/REPL/[gpiI0-9]*` or `N[,M]p`; and every other word is a non-option file
// word that is not itself plain-program shaped (exactly one program). `-e`, `-f`, `-i`, `--expression` etc. are held.
// R17: the GNU/BSD aliases `gsed` and `ssed` get the same rule.
const SED_NAMES = new Set(["sed", "gsed", "ssed"]);
const SED_PLAIN_OPTS =new Set(["-n", "-E", "-r", "-s", "-z"]);
const SED_PLAIN_PROGRAM = /^(s\/[^/]*\/[^/]*\/[gpiI0-9]*|[0-9]+(,[0-9]+)?p)$/;

function sedArgsHold(args: string[]): boolean {
  let programs = 0;
  let sawNonOption = false;
  let optionsDone = false;
  for (const w of args) {
    if (!optionsDone && w === "--") { optionsDone = true; continue; }
    if (!optionsDone && w.startsWith("-")) {
      if (!SED_PLAIN_OPTS.has(w)) return true;
      continue;
    }
    if (!sawNonOption) {
      // The first non-option word is sed's program.
      sawNonOption = true;
      if (!SED_PLAIN_PROGRAM.test(w)) return true;
      programs++;
    } else if (SED_PLAIN_PROGRAM.test(w)) {
      return true;
    }
  }
  return programs !== 1;
}

/** Runs over the segment's de-quoted words AND, separately, over the pieces of each non-plain word, so a `sed`
 *  named inside a quoted word is checked against only that word's own contents. */
function sedHold(words: string[]): boolean {
  const lists = [words];
  for (const w of words) if (NON_PLAIN_CHAR.test(w)) lists.push(w.split(NON_PLAIN_RUN).filter((p) => p.length > 0));
  for (const list of lists) {
    for (let k = 0; k < list.length; k++) {
      if (SED_NAMES.has(base(list[k]!)) && sedArgsHold(list.slice(k + 1))) return true;
    }
  }
  return false;
}

/** Commands that evaluate stdin or a string as shell code (or schedule it), held in any position. */
const STRING_EVALUATORS = new Set(["source", "at", "batch", "crontab", "trap"]);

/**
 * THE shell-syntax character set (one constant, imported by `sshPolicy.ts` too so the two cannot drift): the
 * characters the flat grammar refuses outright, and — once a word has been DE-QUOTED — the characters that
 * can no longer be plain argument text: a word still carrying one is only meaningful as a payload for a
 * nested evaluator (`trap 'r""eboot' EXIT`, `sed '1e …'`), so it is held.
 */
export const SHELL_SYNTAX_CHARS = /[;&|`$()<>{}[\]*?!~#\\"'^]/;

/** Does any de-quoted word still carry shell syntax? (A HOLD in shell mode, whatever the risky list says.) */
export function dequotedWordCarriesShellSyntax(segments: ParsedSegment[]): boolean {
  return segments.some((seg) => seg.words.some((w) => SHELL_SYNTAX_CHARS.test(w)));
}

/**
 * The word list the risky matcher sees for one segment: its de-quoted words, plus — right after any word
 * that holds characters outside the plain-word charset (a quoted payload such as `'rm -rf /x'`) — that word
 * split into its pieces, so a risky command hidden inside a quoted string is still seen. Over-matches by design.
 *
 * @decision 7755b0bd — split on `=` and on a short option's remainder; never a denylist of option names.
 */
export function wordsForRiskyMatch(words: string[], glued = true): string[] {
  const out: string[] = [];
  const addGlued = (s: string): void => {
    if (!glued) return;
    const eq = (t: string): void => {
      if (t.includes("=")) for (const p of t.split("=")) if (p.length > 0) out.push(p);
    };
    eq(s);
    if (/^-[^-]/.test(s) && s.length > 2) {
      const rem = s.slice(2);
      out.push(rem);
      eq(rem);
    }
  };
  for (const w of words) {
    out.push(w);
    addGlued(w);
    if (NON_PLAIN_CHAR.test(w)) {
      for (const piece of w.split(NON_PLAIN_RUN)) if (piece.length > 0) { out.push(piece); addGlued(piece); }
    }
  }
  return out;
}
