// Shared command-line identity-matching primitives for `isOurDaemon` (bin/loom.mjs) and `isOurSupervisor`
// (scripts/daemon-supervisor-stop.mjs) — kept in ONE place (ships under bin/, so both the packaged CLI and
// the dev-only scripts/ tool can import it) so a fix here lands for both callers at once instead of being
// re-applied twice and risking drift, exactly what happened to 279c0208/03cc6cae's own separator-doubling
// bug before this file existed.
//
// @decision 03cc6cae — a Windows npm cmd-shim's `%~dp0`-prefix (already separator-terminated) can double a
// separator in the LIVE command line vs. the Node-normalized recorded `entry` — collapse separator runs on
// BOTH sides before comparing; a single backslash-to-slash swap alone is not enough.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export function normalizeCmdlinePath(s) {
  // POSIX tolerates `//` as equivalent to `/`, so collapsing is safe there too, not just on win32. Fold
  // case only on win32 (POSIX paths are case-sensitive).
  const collapsed = s.replace(/[\\/]+/g, "/");
  return process.platform === "win32" ? collapsed.toLowerCase() : collapsed;
}

// Splits a command line into its individual ARGUMENTS, honoring double-quoted segments (the shape both a
// quoted Windows path and a properly-quoted command-line source use) — never a bare whitespace split,
// which would shatter a quoted path containing spaces into multiple bogus tokens. Only safe to use against
// a command-line STRING that is actually quoted this way (win32's `Get-CimInstance … .CommandLine`) — see
// `cmdlineHasEntryArgumentBoundary` below for the unquoted POSIX `ps` shape, which this must never be used
// against (round-4 Code Review, item 2).
export function splitCommandLineTokens(cmd) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens;
}

// @decision 03cc6cae — exact per-token match against a real argv ARRAY only, never a substring anywhere —
// an unrelated process whose own args merely contain the entry path elsewhere must not satisfy this.
export function argvHasEntryArgument(argv, entry) {
  const normEntry = normalizeCmdlinePath(entry);
  return argv.some((tok) => normalizeCmdlinePath(tok) === normEntry);
}

// @decision 03cc6cae — kept for the win32-shaped (quoted) command-line STRING case; defined in terms of
// `argvHasEntryArgument` so there is only one real matching rule, not two to keep in sync.
export function cmdlineHasEntryArgument(cmd, entry) {
  return argvHasEntryArgument(splitCommandLineTokens(cmd), entry);
}

// @decision 03cc6cae — for an UNQUOTED command-line string we cannot safely tokenize, require `entry` to
// occur at a real argument BOUNDARY (space/string-edge on both sides), never a bare substring — this must
// NOT match `/a/b/index.js` inside `/a/b/index.jsx` or `/a/b/index.js.bak`.
export function cmdlineHasEntryArgumentBoundary(cmd, entry) {
  const normCmd = normalizeCmdlinePath(cmd);
  const normEntry = normalizeCmdlinePath(entry);
  if (!normEntry) return false;
  let fromIndex = 0;
  for (;;) {
    const i = normCmd.indexOf(normEntry, fromIndex);
    if (i === -1) return false;
    const boundaryBefore = i === 0 || normCmd[i - 1] === " ";
    const afterIndex = i + normEntry.length;
    const boundaryAfter = afterIndex === normCmd.length || normCmd[afterIndex] === " ";
    if (boundaryBefore && boundaryAfter) return true;
    fromIndex = i + 1; // keep scanning — the entry text could also occur elsewhere, at a real boundary
  }
}

// @decision 03cc6cae — pick the match strategy by what's actually safe: exact argv (win32/Linux) over
// boundary-match (an unquoted raw string) over refusal — never a naive whitespace split of raw text.
export function matchesRecordedEntry(info, entry) {
  if (!info) return false;
  if (info.argv) return argvHasEntryArgument(info.argv, entry);
  if (info.raw) return cmdlineHasEntryArgumentBoundary(info.raw, entry);
  return false;
}

// Best-effort live command line for `pid`, or `{ raw: null, argv: null }` if it can't be determined (dead,
// permission denied, no tool available). Used ONLY to CONFIRM identity before a kill — never to locate a
// pid to act on by name. `raw` is always the best plain-string rendering we have (used for the LEGACY
// regex fallback, which only ever does a `.test()` on it); `argv` is populated ONLY when we have a real,
// unambiguous argument array to match against — never a naive whitespace split of an unquoted string.
//
// @decision 03cc6cae — Linux reads `/proc/<pid>/cmdline` (exact NUL-separated argv) instead of shelling
// out to `ps`, whose unquoted output can never be safely split for a space-containing `entry`.
export function commandLineOf(pid) {
  try {
    if (process.platform === "win32") {
      // The modern equivalent of `wmic process get commandline` (wmic is deprecated/absent on recent
      // Windows). -NoProfile/-NonInteractive: no PSReadLine, no prompts.
      const r = spawnSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: "utf8", timeout: 5000 });
      if (r.status !== 0) return { raw: null, argv: null };
      const raw = (r.stdout || "").trim() || null;
      return { raw, argv: raw ? splitCommandLineTokens(raw) : null };
    }
    if (process.platform === "linux") {
      try {
        const buf = fs.readFileSync(`/proc/${pid}/cmdline`);
        const argv = buf.toString("utf8").split("\0").filter((s) => s.length > 0);
        if (argv.length === 0) return { raw: null, argv: null };
        return { raw: argv.join(" "), argv };
      } catch {
        return { raw: null, argv: null };
      }
    }
    // -ww: unlimited output width (macOS/BSD `ps` truncates a long command line to the terminal width by
    // default, even when stdout isn't a terminal — a long `entry` path could otherwise be cut off and
    // permanently fail to match, refusing a genuinely-ours daemon forever). Linux's own `ps` isn't reached
    // here at all (see the `/proc` branch above), so this only ever affects macOS/BSD.
    const r = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return { raw: null, argv: null };
    const raw = (r.stdout || "").trim() || null;
    return { raw, argv: null }; // ps's output is unquoted/ambiguous — never safe to tokenize by splitting
  } catch {
    return { raw: null, argv: null };
  }
}
