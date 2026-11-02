#!/usr/bin/env node
// Loom env-isolating launcher for stdio MCP servers. Invoked by claude as the stdio MCP's own "command"
// (never run directly by a human):
//   node env-isolated-launch.mjs --allow <csvKeyNames> -- <realCommand> [...realArgs]
// Rebuilds the real target's child env from a fixed base allowlist plus the named --allow keys, both
// read from THIS process's own inherited env; key NAMES only ever ride argv, VALUES are never logged.
//
// @decision fafae623 — never widen BASE_ALLOWLIST to cover a secret-shaped name (LOOM_MCP_TOKEN,
// CLAUDE_CODE_*, a credential) — a server-specific secret belongs in a mount's own per-call `--allow`
// list, never the shared base allowlist every mount receives unconditionally.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const BASE_ALLOWLIST = [
  "PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC",
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
  "TEMP", "TMP",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "npm_config_cache", "npm_config_registry",
  "PYTHONIOENCODING", "PYTHONUTF8",
  "PLAYWRIGHT_BROWSERS_PATH",
  // POSIX additions (card fafae623 CR round 1, item 5) — UNMEASURED on POSIX (no POSIX host available
  // during this card's work); added because every name is a plausible real need for a POSIX stdio MCP
  // (locale, cert trust, cache/tmp dirs, proxy) and none of them are secret-shaped.
  "XDG_CACHE_HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "ALL_PROXY", "all_proxy",
];

export function parseLauncherArgv(argv) {
  if (argv[0] !== "--allow") return null;
  const allowKeys = (argv[1] ?? "").split(",").filter(Boolean);
  if (argv[2] !== "--") return null;
  const command = argv[3];
  if (!command) return null;
  return { allowKeys, command, args: argv.slice(4) };
}

/** Pure: given the launcher's own inherited env and a per-mount allow list, build the real target's
 *  child env — base allowlist ∪ allowKeys, case-insensitive name match, only present keys copied. */
export function buildIsolatedEnv(processEnv, allowKeys) {
  const wanted = new Set([...BASE_ALLOWLIST, ...allowKeys].map((k) => k.toLowerCase()));
  const env = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (v !== undefined && wanted.has(k.toLowerCase())) env[k] = v;
  }
  return env;
}

/**
 * MEASURED (card fafae623): plain `child_process.spawn(cmd, args, {shell:false})` throws `EINVAL` for a
 * `.cmd`/`.bat` target on win32 — Node no longer auto-wraps a batch file through cmd.exe without
 * `shell:true`. This is the ONE shape among today's stdio mounts that needs special handling (a resolved
 * bare "npx" self-heal, e.g. image-gen's provision) — every other mount resolves to a real binary/.exe/.js
 * and is spawned exactly as before, with no shell involvement at all.
 */
export function needsWindowsCmdHandling(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

// ---------------------------------------------------------------------------------------------------
// Path A: an npm `cmd-shim`-generated `.cmd` (a globally-npm-installed CLI's own shim) — resolve past it
// to the real `node <entry.js>` invocation and spawn THAT directly, with NO shell and NO cmd.exe involved
// at all (so kill() terminates the real process, never a wrapper, and there is no escaping surface to get
// wrong). This mirrors `pty/resolve-bin.ts`'s `needsWindowsCmdShim`/`parseNpmCmdShim`/
// `winCmdShimSpawnTarget` — duplicated here (rather than imported) because every other asset script in
// this directory is deliberately dist-free (see hook-relay.mjs/vault-lint.mjs: they never import from
// ../dist, so this launcher doesn't either); test/win-cmd-shim-parity.mjs pins the two copies identical
// against the same corpus of inputs so they can't silently drift.
// ---------------------------------------------------------------------------------------------------
const NPM_CMD_SHIM_DP0_MARKER = /:find_dp0[\s\S]*?SET dp0=%~dp0/i;
const NPM_CMD_SHIM_NODE_BLOCK_RE =
  /IF EXIST "%dp0%\\node\.exe" \(\r?\n\s*SET "_prog=%dp0%\\node\.exe"\r?\n\) ELSE \(\r?\n\s*SET "_prog=node"\r?\n\s*SET PATHEXT=%PATHEXT:;\.JS;=;%\r?\n\)\r?\n\r?\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +"%dp0%\\([^"]+\.(?:m?js|cjs))" %\*/gi;

/** Returns `{entry, nodeBin}` when `cmdPath`'s content is an npm `cmd-shim`-generated `.cmd`, else `null`
 *  (NEVER throws — a non-matching shape, e.g. Node's own bundled npx.cmd, just falls through to path B). */
export function parseNpmCmdShim(cmdPath) {
  let content;
  try { content = fs.readFileSync(cmdPath, "utf8"); } catch { return null; }
  if (!NPM_CMD_SHIM_DP0_MARKER.test(content)) return null;
  const matches = [...content.matchAll(NPM_CMD_SHIM_NODE_BLOCK_RE)];
  if (matches.length !== 1) return null;
  const capturedEntry = matches[0][1];
  const relativeEntry = capturedEntry.split("\\").join("/");
  const dp0 = path.resolve(path.dirname(cmdPath));
  const entry = path.resolve(path.join(dp0, relativeEntry));
  if (entry !== dp0 && !entry.startsWith(dp0 + path.sep)) return null;
  const siblingNode = path.join(dp0, "node.exe");
  const nodeBin = fs.existsSync(siblingNode) ? siblingNode : process.execPath;
  return { entry, nodeBin };
}

/** `{command, args}` resolved past an npm-cmd-shim `.cmd`, or `null` when `command` isn't one (the
 *  caller falls back to path B). Never shell-involved either way. */
export function winCmdShimSpawnTarget(command, args) {
  if (!needsWindowsCmdHandling(command)) return null;
  const parsed = parseNpmCmdShim(command);
  if (!parsed) return null;
  return { command: parsed.nodeBin, args: [parsed.entry, ...args] };
}

// ---------------------------------------------------------------------------------------------------
// Path B: any OTHER `.cmd`/`.bat` target (Node's own bundled npx.cmd/npm.cmd included — not an npm
// cmd-shim). MUST go through cmd.exe (Windows hands a batch file to it regardless), so this builds the
// `/d /s /c "<line>"` invocation itself, with every argument wrapped in its own literal quote pair —
// cmd.exe's quoting DOES neutralize `&|<>()!^` for an unbroken quoted span (see escapeWindowsCmdArgument's
// own doc for the measured history of what does and doesn't keep a span unbroken). `shell:true` is NEVER
// set here: Node's own shell:true does no escaping at all, which is how Code Review round 1 (reviewer
// b5883c03) found real injection in the prior version of this file. cmd.exe is spawned directly as a
// plain target (shell:false) with a fully pre-escaped, pre-quoted `/c` line and
// `windowsVerbatimArguments:true` so Node never re-quotes it a second time.
// ---------------------------------------------------------------------------------------------------

/**
 * @decision fafae623 — never caret- or backslash-escape a quote here (both reopen the cmd.exe injection
 * this closes; doubling `""` is the only form that survived measurement). Never attempt to make `%` or a
 * CR/LF safe here either — refuse them; every `%`-escaping attempt still measured as expanding.
 */
export function escapeWindowsCmdArgument(value) {
  const s = String(value);
  if (/[\r\n]/.test(s)) {
    throw new Error(`env-isolated-launch: refusing to pass an argument containing a newline through cmd.exe (would silently truncate it): ${JSON.stringify(s)}`);
  }
  if (s.includes("%")) {
    throw new Error(`env-isolated-launch: refusing to pass an argument containing '%' through cmd.exe (variable expansion cannot be reliably suppressed on this path): ${JSON.stringify(s)}`);
  }
  const inner = s.replace(/(\\*)"/g, (_m, backslashes) => backslashes + backslashes + '""').replace(/(\\+)$/, "$1$1");
  return `"${inner}"`;
}

/** Build the exact `cmd.exe` argv (`["/d","/s","/c", line]`) for spawning `command`/`args` with every
 *  piece escaped by {@link escapeWindowsCmdArgument}. Exported so the regression test can assert on the
 *  constructed line directly, not just on a real spawn's behavior. */
export function buildWindowsCmdInvocation(command, args) {
  const escaped = [command, ...args].map(escapeWindowsCmdArgument);
  // Mirrors Node's own shell:true wrapping (`normalizeSpawnArguments`) and is REQUIRED, not cosmetic:
  // `/d /s` makes cmd.exe strip exactly the line's first character (if a quote) and the LAST quote
  // character anywhere in the line — wrapping the already-escaped line in one more literal quote pair
  // gives it exactly that one outermost pair to strip, leaving every quote `escapeWindowsCmdArgument`
  // produced untouched and still grouping correctly (MEASURED: omitting this wrap, or caret-escaping
  // these two outer quotes, both break grouping for any command/arg containing a space).
  const line = `"${escaped.join(" ")}"`;
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  // /v:off (Code Review round 2, reviewer 7b1b9aa0): disables registry-configured DelayedExpansion so a
  // `!VAR!` in an argument can never be expanded by cmd.exe itself — including the isolated env's own
  // forwarded secret values. /d already suppresses AutoRun; this closes the SEPARATE DelayedExpansion
  // vector /d alone doesn't touch.
  return { comspec, args: ["/d", "/v:off", "/s", "/c", line] };
}

function spawnTarget(command, args, env) {
  if (process.platform === "win32" && needsWindowsCmdHandling(command)) {
    const shimTarget = winCmdShimSpawnTarget(command, args);
    if (shimTarget) return spawn(shimTarget.command, shimTarget.args, { env, stdio: "inherit" });
    const { comspec, args: cmdArgs } = buildWindowsCmdInvocation(command, args);
    return spawn(comspec, cmdArgs, { env, stdio: "inherit", windowsVerbatimArguments: true });
  }
  return spawn(command, args, { env, stdio: "inherit" });
}

function main() {
  const parsed = parseLauncherArgv(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write("[loom:env-isolated-launch] usage: env-isolated-launch.mjs --allow <csv> -- <command> [args...]\n");
    process.exit(1);
    return;
  }
  const env = buildIsolatedEnv(process.env, parsed.allowKeys);
  let child;
  try {
    child = spawnTarget(parsed.command, parsed.args, env);
  } catch (err) {
    process.stderr.write(`[loom:env-isolated-launch] refused to spawn ${parsed.command}: ${err.message}\n`);
    process.exit(1);
    return;
  }
  child.on("exit", (code, signal) => { process.exit(signal ? 1 : (code ?? 1)); });
  child.on("error", (err) => {
    process.stderr.write(`[loom:env-isolated-launch] failed to spawn ${parsed.command}: ${err.message}\n`);
    process.exit(1);
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* best-effort */ } });
  }
}

// Run only when invoked directly (claude spawning this as the MCP's own command) — never on import
// (the hermetic unit test imports buildIsolatedEnv/parseLauncherArgv without wanting a real spawn).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
