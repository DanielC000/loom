/**
 * Loom-side command policy for `ssh_exec`: the checks that run BEFORE any byte goes on the wire.
 *
 * ⚠️ This is defense-in-depth, NOT the security boundary. The command text is handed to a remote SHELL, so
 * any word-level check is only as sound as its refusal of shell syntax. The real boundary is the
 * server-side dedicated least-privileged user (+ `restrict` in authorized_keys) the owner provisions.
 *
 * @decision a3d5c7f4 — shell syntax is refused on EVERY command, BEFORE any rule is matched, whatever
 * `readOnly` or the rule types say; never relax it by inference (unanchored `^ls` would pass `ls; reboot`).
 */
import type { ConnectionMetadata, SshCommandRule } from "@loom/shared";
import { testRegexesBounded } from "./sshRegex.js";

/** Longest command text accepted (chars) — the cap is applied before any matching. */
export const SSH_MAX_COMMAND_LENGTH = 4096;

export type SshRefusalReason =
  | "invalid-command" | "command-too-long" | "control-characters" | "non-ascii-characters"
  | "shell-metacharacters" | "allowlist-regex-timeout" | "risky-pattern-requires-approval"
  | "not-read-only-verb" | "not-in-allowlist";

export type SshPolicyVerdict = { allowed: true } | { allowed: false; reason: SshRefusalReason };

// After the ASCII/control gate, every character that could start an expansion, substitution, redirection,
// job/command separator, quoting, escaping, globbing or comment is refused outright (a denylist of syntax
// rather than a parser — quoting tricks are refused, not interpreted).
const SHELL_METACHARS = /[;&|`$()<>{}[\]*?!~#\\"'^]/;

// Read-only mode's fixed verb list. Deliberately small, and it limits which VERBS run — NOT what the
// server-side user can read (cat/grep/ps can still read anything that user can). Verbs with a mutating
// flag/argument form (hostname NAME, date SETTING, file -C, sort -o, find -delete, dmesg -c, ip, ss -K,
// journalctl --vacuum) are either argument-constrained below or absent. The owner can widen the list
// per connection through the allowlist.
const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "df", "du", "uptime", "uname", "whoami", "id", "free", "ps", "stat",
  "pwd", "lsblk", "grep",
]);
// `systemctl <sub> [unit]` — the subcommand must be words[1] with NO option before it. Never infer a
// subcommand past an option: `systemctl -o cat stop sshd` has "cat" as the VALUE of -o.
const SYSTEMCTL_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "is-active", "is-enabled"]);
// `docker ps` only, with flags that provably take no value.
const DOCKER_PS_VALUELESS_FLAGS: ReadonlySet<string> = new Set(["-a", "-q", "--all", "--quiet", "--no-trunc"]);

const baseName = (word: string): string => {
  const i = word.lastIndexOf("/");
  return i >= 0 ? word.slice(i + 1) : word;
};

function isReadOnlyCommand(words: string[]): boolean {
  const verb = words[0] ?? "";
  if (READ_ONLY_VERBS.has(verb)) return true;
  if (verb === "hostname") return words.length === 1;
  if (verb === "date") return words.length === 1 || (words.length === 2 && (words[1] ?? "").startsWith("+"));
  if (verb === "systemctl") {
    const unit = words[2];
    return SYSTEMCTL_READ_ONLY_SUBCOMMANDS.has(words[1] ?? "") && words.length <= 3 && (unit === undefined || !unit.startsWith("-"));
  }
  if (verb === "docker") {
    return words[1] === "ps" && words.slice(2).every((w) => DOCKER_PS_VALUELESS_FLAGS.has(w));
  }
  return false;
}

/** Does a non-regex risky rule match ANYWHERE in the tokenized command (after path-basename folding, so
 *  `/sbin/reboot` and `sudo reboot` both match `reboot`)? A prefix pattern's words must appear as a
 *  contiguous run; its LAST word is a prefix match unless the pattern ended in a space. A `systemctl`
 *  word IMMEDIATELY followed by an exact read-only subcommand is exempt. */
function riskyWordMatch(rule: SshCommandRule, words: string[], trimmed: string): boolean {
  if (rule.kind === "exact") return trimmed === rule.pattern.trim();
  const pwords = rule.pattern.split(/ +/).filter((w) => w.length > 0);
  if (pwords.length === 0) return false;
  const lastIsWhole = /\s$/.test(rule.pattern);
  const folded = words.map(baseName);
  for (let i = 0; i + pwords.length <= folded.length; i++) {
    let ok = true;
    for (let k = 0; k < pwords.length && ok; k++) {
      const w = (k === 0 ? folded[i + k] : words[i + k]) ?? "";
      const p = pwords[k] ?? "";
      ok = k === pwords.length - 1 && !lastIsWhole ? w.startsWith(p) : w === p;
    }
    if (!ok) continue;
    // Exempt only when the subcommand IMMEDIATELY follows `systemctl` — any option before it drops the
    // exemption (the next bare word may be an option's value, not the subcommand).
    if (folded[i] === "systemctl" && SYSTEMCTL_READ_ONLY_SUBCOMMANDS.has(words[i + 1] ?? "")) continue;
    return true;
  }
  return false;
}

/**
 * Decide whether `command` may be dispatched on `conn`. Order: length → ASCII/control → shell syntax →
 * (regex rules, one bounded worker call) → risky patterns → read-only verb → allowlist. The first failing
 * check names the refusal. Never throws.
 */
export async function evaluateSshCommandPolicy(
  conn: Pick<ConnectionMetadata, "readOnly" | "commandAllowlist" | "riskyCommandPatterns">,
  command: unknown,
): Promise<SshPolicyVerdict> {
  const refuse = (reason: SshRefusalReason): SshPolicyVerdict => ({ allowed: false, reason });
  if (typeof command !== "string") return refuse("invalid-command");
  if (command.length > SSH_MAX_COMMAND_LENGTH) return refuse("command-too-long");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(command)) return refuse("control-characters");
  if (/[^\x20-\x7e]/.test(command)) return refuse("non-ascii-characters");
  if (SHELL_METACHARS.test(command)) return refuse("shell-metacharacters");
  const trimmed = command.trim();
  if (trimmed.length === 0) return refuse("invalid-command");
  const words = trimmed.split(/ +/);

  const allowlist = conn.commandAllowlist ?? [];
  const risky = conn.riskyCommandPatterns ?? [];

  // ONE worker call evaluates every regex rule (allowlist + risky) under one total budget.
  const regexPatterns: string[] = [];
  const regexSlot = new Map<SshCommandRule, number>();
  for (const r of [...allowlist, ...risky]) {
    if (r.kind === "regex") { regexSlot.set(r, regexPatterns.length); regexPatterns.push(r.pattern); }
  }
  let regexResults: Array<boolean | null> = [];
  if (regexPatterns.length > 0) {
    const res = await testRegexesBounded(regexPatterns, trimmed);
    if (!res.ok) return refuse("allowlist-regex-timeout");
    regexResults = res.results;
  }

  for (const rule of risky) {
    // An uncompilable risky regex (null) fails closed as a match.
    const hit = rule.kind === "regex" ? regexResults[regexSlot.get(rule)!] !== false : riskyWordMatch(rule, words, trimmed);
    if (hit) return refuse("risky-pattern-requires-approval");
  }
  if (conn.readOnly && !isReadOnlyCommand(words)) return refuse("not-read-only-verb");
  if (allowlist.length > 0) {
    const ok = allowlist.some((rule) => {
      if (rule.kind === "exact") return trimmed === rule.pattern;
      if (rule.kind === "prefix") return trimmed.startsWith(rule.pattern);
      return regexResults[regexSlot.get(rule)!] === true;
    });
    if (!ok) return refuse("not-in-allowlist");
  }
  return { allowed: true };
}

/** Host/user shape check for the values read off the connection ROW (the store accepts control chars and
 *  whitespace there). Pure; returns an error string or null. */
export function sshTargetShapeError(host: unknown, user: unknown): string | null {
  if (typeof host !== "string" || host.length === 0 || host.length > 253 || !/^[A-Za-z0-9._:-]+$/.test(host)) {
    return "connection host has an invalid shape";
  }
  if (typeof user !== "string" || user.length === 0 || user.length > 64 || !/^[A-Za-z0-9._-]+$/.test(user)) {
    return "connection user has an invalid shape";
  }
  return null;
}
