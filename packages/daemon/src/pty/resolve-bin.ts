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

/**
 * Matches the ENTIRE canonical node-interpreter dispatch block a real npm `cmd-shim` emits for a
 * node-shebanged package, end to end in one contiguous pattern (verified byte-identical, modulo the
 * entry path, against this host's real `codex.cmd`/`corepack.cmd`/`pnpm.cmd`, all genuine
 * `npm install -g` outputs):
 * ```
 * IF EXIST "%dp0%\node.exe" (
 *   SET "_prog=%dp0%\node.exe"
 * ) ELSE (
 *   SET "_prog=node"
 *   SET PATHEXT=%PATHEXT:;.JS;=;%
 * )
 *
 * endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\<entry>.js" %*
 * ```
 * Matching the whole block in one pattern (rather than the dp0-lookup and the invocation line
 * independently, the shape this replaced) means interpreter identity and entry extraction come from the
 * SAME match, so a decoy invocation-shaped line elsewhere in the file (behind a `REM`, or a second copy)
 * can never be mistaken for the real one — {@link parseNpmCmdShim} additionally requires this to match
 * EXACTLY ONCE. Both `_prog` markers are pinned to the literal `node`/`node.exe`: `cmd-shim` derives
 * `_prog` from the target script's OWN shebang interpreter (any word — `deno`, `bun`, `python3`, ...),
 * not always `node`, so a package whose shebang names a different interpreter produces a real cmd-shim
 * that legitimately sets `_prog` to that interpreter instead, and this module only knows how to safely
 * launch the entry under node. `"%_prog%" +"` requires NOTHING but spaces between the interpreter and
 * the entry's opening quote — a shebang carrying extra interpreter args (`#!/usr/bin/env node --harmony`)
 * inserts that text in exactly this gap, so such a shim fails to match rather than silently dropping or
 * misparsing the flags.
 *
 * @decision adeb453f — do not loosen this to lenient-match a shim missing these exact node markers, and
 * do not drop the exactly-one-match requirement in {@link parseNpmCmdShim} — either reopens the decoy
 * and wrong-interpreter defects this was written to close.
 */
const NPM_CMD_SHIM_NODE_BLOCK_RE =
  /IF EXIST "%dp0%\\node\.exe" \(\r?\n\s*SET "_prog=%dp0%\\node\.exe"\r?\n\) ELSE \(\r?\n\s*SET "_prog=node"\r?\n\s*SET PATHEXT=%PATHEXT:;\.JS;=;%\r?\n\)\r?\n\r?\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +"%dp0%\\([^"]+\.(?:m?js|cjs))" %\*/gi;

/**
 * Parse an npm `cmd-shim`-generated `.cmd` file (the shape a global `npm install -g <pkg>` produces on
 * Windows) WITHOUT executing it, and resolve the real target it would ultimately exec. See
 * {@link winCmdShimSpawnTarget} for why: spawning node directly on the real entry script needs neither a
 * shell nor an intermediary `cmd.exe` process, so argv reaches the target completely unescaped (no
 * quoting/caret-escaping layer exists to get wrong) and `kill()` terminates the actual process instead of
 * a `cmd.exe` wrapper, orphaning the real child.
 *
 * What this ACTUALLY enforces (positive form — a file can contain other shell logic outside the matched
 * block and this never inspects it, which is safe only because of how the parsed result is used): accepts
 * a file if and only if it carries the dp0 lookup AND {@link NPM_CMD_SHIM_NODE_BLOCK_RE}'s dispatch block
 * matches it EXACTLY ONCE, with a captured entry that resolves to a path inside the shim's own directory
 * tree (`path.resolve` containment — a relative entry can't `..` its way out). That's safe because
 * content OUTSIDE the matched block never runs: Loom never executes the `.cmd` itself (never
 * `shell:true`, never `cmd.exe` — {@link winCmdShimSpawnTarget}), it spawns the resolved node binary
 * directly against the resolved entry script, so any other line in the file — real or decoy — is dead
 * text from this module's point of view.
 *
 * Deliberately refuses (rather than attempts to also parse) a pnpm-global-install shim (`pnpm add -g`)
 * or an npm ≤6 `cmd-shim` shim: both use a materially different, less deterministic template — no
 * `dp0`/`_prog` indirection at all, and TWO independent literal invocation lines (one per `IF
 * EXIST`/`ELSE` branch) that would need cross-validating against each other to trust, plus — for the
 * pnpm shape — an entry path that embeds a mutable global-store generation index. The resulting clear,
 * named refusal error (never the old silent "exit null") is the intended user-facing signal for this
 * case.
 *
 * @decision adeb453f — do not special-case the pnpm-global/npm≤6 template to also accept it; its dual
 * invocation sites and mutable store-index entry path make it unsafe to anchor on the same way.
 *
 * Throws a plain `Error` (never a sentinel) naming `cmdPath`. Every caller wraps its spawn attempt in a
 * try/catch that already surfaces a synchronous spawn failure into its own diagnostic output, so throwing
 * here is swallowed the same way.
 */
export function parseNpmCmdShim(cmdPath: string): ParsedNpmCmdShim {
  const text = fs.readFileSync(cmdPath, "utf8");
  if (!NPM_CMD_SHIM_DP0_MARKER.test(text)) {
    throw new Error(`"${cmdPath}" is not a recognisable npm cmd-shim (missing its dp0 lookup) — refusing to spawn it through a shell`);
  }
  const blockMatches = [...text.matchAll(NPM_CMD_SHIM_NODE_BLOCK_RE)];
  if (blockMatches.length !== 1) {
    throw new Error(
      `"${cmdPath}" is not a recognisable npm cmd-shim (expected exactly one node-interpreter dispatch block — "%_prog%" set to "%dp0%\\node.exe"/"node" with nothing but the entry between it and "%*" — found ${blockMatches.length}) — refusing to spawn it through a shell`,
    );
  }
  // The captured entry is always a Windows-style (backslash) relative path — the shim file is a Windows
  // batch script by construction regardless of which OS is doing the parsing (e.g. a hermetic test on
  // POSIX CI) — normalize to "/" first so path.join/path.resolve's ".." handling, and the containment
  // check below, are correct on every host, not just win32.
  const match = blockMatches[0];
  const capturedEntry = match?.[1];
  if (!capturedEntry) throw new Error(`"${cmdPath}" cmd-shim parse failed unexpectedly after matching exactly once`);
  const relativeEntry = capturedEntry.split("\\").join("/");
  const dp0 = path.resolve(path.dirname(cmdPath));
  const entry = path.resolve(path.join(dp0, relativeEntry));
  if (entry !== dp0 && !entry.startsWith(dp0 + path.sep)) {
    throw new Error(`"${cmdPath}" cmd-shim entry resolves outside the shim's own directory (${dp0}) — refusing to spawn it through a shell`);
  }
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
