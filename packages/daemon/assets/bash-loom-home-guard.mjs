#!/usr/bin/env node
// PreToolUse(Bash) guard for Loom-driven agent roles: refuse a shell command that NAMES the real
// LOOM_HOME's database, its backups, or its secret key (decision record: docs/decisions/da1a4a1b-*.md).
//
// Standalone asset (invoked as `node bash-loom-home-guard.mjs <realLoomHome>`), zero imports from the
// daemon's dist — same shipping shape as decision-records.mjs. The pure matcher is exported for the test;
// the stdin/exit-code wrapper only runs when this file is the entry script.
//
// STRING-BASED, defense in depth only: it stops accidents and the casual "open the DB from a node
// script" path. It does NOT stop a path assembled at runtime, a symlink, or a script file that reads the
// path from its own env. See the record for the residual list.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SENSITIVE = [
  "loom.db", "loom.db-wal", "loom.db-shm", "secret.key",
  "gateway-loopback.key", // the human-REST bearer secret
  ".env", // daemon environment file (may carry provider keys)
  "backups", // DB snapshots
  "tmp/settings", // per-session settings + mcp-config files: hook tokens and MCP capability secrets
];
const DIR_ENTRIES = new Set(["backups", "tmp/settings"]);
// Bare tokens that, combined with the home DIRECTORY appearing in the command (e.g. `cd ~/.loom && sqlite3
// loom.db`), also count. `backups` is excluded here: too common a word to key on without a full path.
const BARE_TOKENS = ["loom.db", "secret.key", "gateway-loopback.key", ".env"];

function norm(s, win) {
  let out = String(s).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (win) out = out.toLowerCase();
  return out;
}

/** Commands longer than this fail CLOSED: bounds work per call and refuses a pathological input outright. */
export const MAX_COMMAND_CHARS = 65536;
export const TOO_LONG_REASON = "command too long for the Loom Bash guard";

/** Single-pass lexical `.`/`..` collapse of ONE path token (already `/`-normalised). Linear in its length. */
function collapseToken(tok) {
  if (!tok.includes("/")) return tok;
  const segs = tok.split("/");
  const rooted = segs[0] === "" || /^[a-z]:$/i.test(segs[0]);
  const out = [];
  let trailing = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (i === 0) {
      if (rooted || s !== ".") out.push(s);
      continue;
    }
    if (s === "") { if (i === segs.length - 1) trailing = true; continue; }
    if (s === ".") continue;
    if (s === "..") {
      if (rooted) { if (out.length > 1) out.pop(); } // `..` right after the root is dropped
      else if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(s);
  }
  let joined = out.join("/");
  if (rooted && out.length === 1) joined += "/";
  else if (trailing && !joined.endsWith("/")) joined += "/";
  return joined;
}

/** Returns a refusal reason string, or null when the command is allowed. */
export function checkCommand(command, realLoomHome, opts = {}) {
  const win = opts.win32 ?? process.platform === "win32";
  const homedir = opts.homedir ?? os.homedir();
  if (typeof command !== "string" || !command || !realLoomHome) return null;

  const home = norm((win ? path.win32 : path.posix).resolve(realLoomHome), win).replace(/\/+$/, "");
  const userHome = norm(homedir, win).replace(/\/+$/, "");
  // The cap bounds every later pass; over it the caller fails CLOSED (see TOO_LONG_REASON / main()).
  if (command.length > MAX_COMMAND_CHARS) return TOO_LONG_REASON;
  // NORMALISE ONCE, before ANY rule runs: (a) strip every quote char (approximates bash quote removal, so
  // `cat ../"loom.db"` and `cat ..'/.env'` read as what bash executes), then (b) slashes/case/expansion,
  // then (c) the single-pass path collapse below. Every rule operates on the normalised text only, so a
  // per-rule quote or separator tolerance is no longer the thing that has to be right.
  let cmd = command.replace(/["']/g, "").replace(/\\/g, "/");
  if (win) cmd = cmd.toLowerCase();

  // No LOOM_HOME-reassignment exemption: bash expands `$LOOM_HOME` BEFORE a prefix assignment applies
  // (`LOOM_HOME=/tmp/x cp $LOOM_HOME/loom.db y` reads the REAL db), so honouring one is a bypass. The
  // hermetic shape `LOOM_HOME=<tmp> node test.mjs` never names `$LOOM_HOME/<sensitive>`, so it passes anyway.
  const L = (t) => (win ? t.toLowerCase() : t);
  const pairs = [
    [/(^|[\s"'=:(<>])~(?=\/|$|\s|["';&|<>)])/g, "$1" + userHome],
    [new RegExp("\\$\\{?" + L("home") + "\\}?", "g"), userHome],
    [/%userprofile%/gi, userHome],
    [/\$\{?userprofile\}?/gi, userHome],
    [/\$env:(userprofile|home)/gi, userHome],
  ];
  // POSIX env var names are case-sensitive; only fold them on win32 (cmd is already lowercased there).
  if (!win) {
    pairs.length = 0;
    pairs.push(
      [/(^|[\s"'=:(<>])~(?=\/|$|\s|["';&|<>)])/g, "$1" + userHome],
      [/\$\{?HOME\}?/g, userHome],
      [/%USERPROFILE%/gi, userHome],
      [/\$\{?USERPROFILE\}?/g, userHome],
      [/\$env:(USERPROFILE|HOME)/gi, userHome],
    );
  }
  pairs.push([/%loom_home%/gi, home], [/\$env:loom_home/gi, home]);
  pairs.push([win ? /\$\{?loom_home\}?/g : /\$\{?LOOM_HOME\}?/g, home]);
  for (const [re, rep] of pairs) cmd = cmd.replace(re, rep);
  cmd = cmd.replace(/\/{2,}/g, "/");
  // `/c/Users/x` (Git Bash) and `c:/Users/x` name the same place: normalise to the drive form BEFORE collapsing
  // so a `..` right after the drive root is recognised as a root-climb.
  if (win) cmd = cmd.replace(/(^|[\s=:(<>])\/([a-z])\//g, "$1$2:/");
  // Lexically collapse `.` and `seg/..` per path token (a maximal run of non-separator chars), ONE pass with a
  // segment stack, so it is linear (the previous regex fixpoint loop was quadratic). A `..` right after a root
  // (`/`, `x:`) is dropped, as the OS does. A `..` that climbs out of a RELATIVE start (`cd <home>/tmp && cat
  // ../loom.db`) cannot be collapsed here; the traversal rule below covers it.
  cmd = cmd.replace(/[^\s;&|<>()=]+/g, collapseToken);
  cmd = cmd.replace(/\/{2,}/g, "/");

  for (const hay of [cmd]) {
    for (const name of SENSITIVE) {
      const target = home + "/" + (win ? name.toLowerCase() : name);
      let i = hay.indexOf(target);
      while (i !== -1) {
        const next = hay.charAt(i + target.length);
        // A FILE entry is refused on any suffix (`loom.db.bak`, `.env.local`, `.envrc` all count: sensitive
        // in spirit, and a few false positives are cheaper than a bypass). A DIR entry is refused unless the
        // next char continues a longer NAME (`backups-old`, `tmp/settingsx`); `/` and separators still match.
        if (!DIR_ENTRIES.has(name) || !/[A-Za-z0-9_-]/.test(next)) {
          return `names ${home}/${name}`;
        }
        i = hay.indexOf(target, i + 1);
      }
    }
    // The home directory ITSELF named (end, whitespace, quote, `;&|)`, optionally one trailing `/`) + a bare
    // sensitive token (`cd ~/.loom && sqlite3 loom.db`). A path that DESCENDS further (`<home>/tmp/scratch/…`,
    // `<home>/logs/…`) is not the home dir and must not trigger this rule: the worker's own scratch dir lives there.
    const dirRe = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?(?=$|[\\s\"';&|<>)])");
    const tokRe = (tok, prefix) => new RegExp("(" + prefix + ")" + tok.replace(/\./g, "\\.") + "($|[\\s\"';&|<>)])");
    if (dirRe.test(hay)) {
      for (const tok of BARE_TOKENS) {
        if (tokRe(tok, "^|[\\s\"'/=<>]").test(hay)) {
          return `names ${home} together with ${tok}`;
        }
      }
    }
    // A DESCENDANT of the home named (`cd <home>/tmp`, `<home>/logs/x`) plus a sensitive bare token reached
    // through `../` (`cat ../loom.db`, `cp ../../../secret.key x`). The worker's own scratch usage never needs
    // `../<sensitive>`, so the scratch false-positives stay allowed.
    if (hay.includes(home + "/")) {
      for (const tok of BARE_TOKENS) {
        if (tokRe(tok, "\\.\\./").test(hay)) return `names a descendant of ${home} and reaches ${tok} through ../`;
      }
    }
  }
  return null;
}

export const REFUSAL_PREFIX =
  "Refused: this command names the real Loom data directory's database, backups or secret key. " +
  "Worker/agent sessions must never open the owner's real loom.db, its backups, secret.key, gateway-loopback.key, .env or session settings (they hold " +
  "credentials and all project data). For a test, use a temp LOOM_HOME of your own. ";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  // argv[2] is the real LOOM_HOME, either plain or `b64:<base64url>` (the daemon passes the latter so no
  // character in the path — backslash, `$`, `%`, quote — can break the hook command's shell quoting).
  // A malformed/missing argument fails CLOSED and visibly (exit 2): a silently-unguarded worker is worse than
  // a loudly-blocked one. Only an unparseable stdin PAYLOAD below fails open.
  const arg = process.argv[2] ?? "";
  const bad = (why) => {
    process.stderr.write(`Loom Bash guard misconfigured: ${why}. Report this to your manager.\n`);
    process.exit(2);
  };
  let realLoomHome = arg;
  if (arg.startsWith("b64:")) {
    const enc = arg.slice(4);
    realLoomHome = Buffer.from(enc, "base64url").toString("utf8");
    if (!enc || Buffer.from(realLoomHome, "utf8").toString("base64url") !== enc) bad("the LOOM_HOME argument is not valid base64url");
  } else if (!arg) {
    bad("no LOOM_HOME argument was given");
  }
  if (!path.win32.isAbsolute(realLoomHome) && !path.posix.isAbsolute(realLoomHome)) bad("the LOOM_HOME argument is not an absolute path");
  let command = "";
  try {
    const payload = JSON.parse(await readStdin());
    command = payload?.tool_input?.command ?? "";
  } catch {
    process.exit(0); // unparseable payload: fail open (advisory layer; never wedge the session)
  }
  const reason = checkCommand(command, realLoomHome);
  if (reason === TOO_LONG_REASON) {
    process.stderr.write(`Refused: ${TOO_LONG_REASON} (over ${MAX_COMMAND_CHARS} characters). Split it into smaller commands or put the script in a file.\n`);
    process.exit(2);
  }
  if (reason) {
    process.stderr.write(REFUSAL_PREFIX + `(${reason})\n`);
    process.exit(2); // exit 2 = block the tool call; stderr is fed back to the model
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
