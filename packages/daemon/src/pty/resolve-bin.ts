import fs from "node:fs";
import path from "node:path";

const cache = new Map<string, string>();

/**
 * Resolve an executable to an ABSOLUTE path. Critical on Windows: node-pty's agent
 * does NOT search %PATH%, so we must hand it a fully-qualified path. (Ported from the predecessor.)
 */
export function resolveExecutable(name: string): string {
  if (!name) return name;
  if (path.isAbsolute(name)) return name;
  if (name.includes("/") || name.includes("\\")) return path.resolve(name);

  const cached = cache.get(name);
  if (cached) {
    // @decision 8e08eec1 — a cached hit is re-verified with a cheap existsSync before being trusted;
    // a moved/uninstalled/upgraded shim (fnm/nvm/volta) must not be served forever from a stale cache.
    if (fs.existsSync(cached)) return cached;
    cache.delete(name);
  }

  const PATH = process.env.PATH || process.env.Path || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = PATH.split(sep).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExt = process.platform === "win32" && path.extname(name).length > 0;

  for (const dir of dirs) {
    const candidates = hasExt ? [path.join(dir, name)] : exts.map((e) => path.join(dir, name + e));
    for (const c of candidates) {
      if (fs.existsSync(c)) { cache.set(name, c); return c; }
    }
  }
  return name;
}

/** True only on win32 for a `command` that ends in `.cmd`/`.bat` — the shape {@link resolveExecutable}'s
 *  own PATHEXT search can hand back for a PATH-resolvable name (e.g. an npm-global CLI's shim), and the
 *  one Node (as of 18.20.2/20.12.2/22.x, the CVE-2024-27980 mitigation) REFUSES to `spawn()`/`spawnSync()`
 *  directly without `shell:true` — Windows' `CreateProcess` implicitly hands a batch file to `cmd.exe`
 *  regardless of the caller's shell option, so Node now throws a synchronous `EINVAL` rather than risk an
 *  unescaped argument reaching that implicit shell. See {@link winCmdShimSpawnTarget}. */
export function needsWindowsCmdShim(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/** What {@link parseNpmCmdShim} resolves off a real npm `cmd-shim`-generated `.cmd` file. */
export interface ParsedNpmCmdShim {
  /** Absolute path to the `.js`/`.mjs`/`.cjs` entry script the shim ultimately execs. */
  entry: string;
  /** Absolute path to the node binary the shim itself prefers: its own sibling `node.exe` beside the
   *  `.cmd` file when present on disk (the shim's own `IF EXIST "%dp0%\node.exe"` branch), else the
   *  CURRENTLY RUNNING node ({@link process.execPath}) — never a bare `"node"` relying on %PATH%, since
   *  everything spawned this way already needs a fully-qualified path (see {@link resolveExecutable}'s
   *  own doc above). */
  nodeBin: string;
}

/** npm's own `cmd-shim`-generated `.cmd` template always defines this dp0-lookup pair near the top —
 *  cheap membership check before trusting the file enough to extract an entry path from it. */
const NPM_CMD_SHIM_DP0_MARKER = /:find_dp0[\s\S]*?SET dp0=%~dp0/i;

/** Matches the shim's one real invocation line — e.g. `"%_prog%"  "%dp0%\node_modules\@openai\codex\bin\
 *  codex.js" %*` (verified against this host's real npm-installed `codex.cmd`/`corepack.cmd`/`pnpm.cmd`,
 *  all byte-identical in shape). `cmd-shim` always emits exactly this trailing ` %*` forwarding every
 *  argument verbatim — captures the relative entry path after `%dp0%\`. */
const NPM_CMD_SHIM_ENTRY_RE = /"%_prog%"\s+"%dp0%\\([^"]+\.(?:m?js|cjs))"\s+%\*/i;

/**
 * Parse an npm `cmd-shim`-generated `.cmd` file (the shape a global `npm install -g <pkg>` produces on
 * Windows) WITHOUT executing it, and resolve the real target it would ultimately exec. See
 * {@link winCmdShimSpawnTarget} for why: spawning node directly on the real entry script needs neither a
 * shell nor an intermediary `cmd.exe` process, so argv reaches the target completely unescaped (no
 * quoting/caret-escaping layer exists to get wrong) and `kill()` terminates the actual process instead of
 * a `cmd.exe` wrapper, orphaning the real child.
 *
 * Throws a plain `Error` (never a sentinel) naming `cmdPath` when the file isn't a recognisable npm
 * cmd-shim — e.g. a hand-authored `.cmd`/`.bat` with arbitrary shell logic, which this deliberately never
 * attempts to interpret; falling back to a shell for that case would reopen the exact escaping gap this
 * whole module exists to close. Every caller wraps its spawn attempt in a try/catch that already surfaces
 * a synchronous spawn failure into its own diagnostic output, so throwing here is swallowed the same way.
 */
export function parseNpmCmdShim(cmdPath: string): ParsedNpmCmdShim {
  const text = fs.readFileSync(cmdPath, "utf8");
  if (!NPM_CMD_SHIM_DP0_MARKER.test(text)) {
    throw new Error(`"${cmdPath}" is not a recognisable npm cmd-shim (missing its dp0 lookup) — refusing to spawn it through a shell`);
  }
  const entryMatch = NPM_CMD_SHIM_ENTRY_RE.exec(text);
  const relativeEntry = entryMatch?.[1];
  if (!relativeEntry) {
    throw new Error(`"${cmdPath}" is not a recognisable npm cmd-shim (no "%dp0%\\...<entry>.js" %* invocation line found) — refusing to spawn it through a shell`);
  }
  const dp0 = path.dirname(cmdPath);
  const entry = path.join(dp0, relativeEntry);
  const siblingNode = path.join(dp0, "node.exe");
  const nodeBin = fs.existsSync(siblingNode) ? siblingNode : process.execPath;
  return { entry, nodeBin };
}

/**
 * Resolve the safe, shell-free spawn target for a `command`/`args` pair whose `command`
 * {@link needsWindowsCmdShim}. A no-op passthrough (returns `{command, args}` unchanged) off win32, or
 * for a `command` that isn't a `.cmd`/`.bat` — every existing spawn stays byte-identical there.
 *
 * @decision 8ddd12c6 — never route a resolved `.cmd`/`.bat` through `cmd.exe` to "fix" the
 * CVE-2024-27980 `EINVAL`, even correctly quoted/escaped: every spawned child becomes `cmd.exe` itself,
 * so `kill()` only kills the wrapper and orphans the real process.
 */
export function winCmdShimSpawnTarget(command: string, args: string[]): { command: string; args: string[] } {
  if (!needsWindowsCmdShim(command)) return { command, args };
  const { entry, nodeBin } = parseNpmCmdShim(command);
  return { command: nodeBin, args: [entry, ...args] };
}
