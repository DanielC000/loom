import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LOOM_HOME } from "../paths.js";

/**
 * Loom's ONE shared, Loom-MANAGED Python virtualenv — the single home for every Python tool Loom provisions
 * (markitdown today; future Python features reuse the SAME venv, never a venv-per-tool). It lives under
 * `<LOOM_HOME>/python/venv`, so it's daemon-owned state like everything else under ~/.loom and is wiped with
 * it. Loom installs PACKAGES into it; it NEVER installs the interpreter — the user supplies a base Python
 * (≥3.10) on PATH or via the human-only `python.interpreterPath` config (see {@link discoverBasePythonAsync}).
 *
 * EVENT-LOOP DISCIPLINE: creating a venv + `pip install markitdown[all]` takes minutes, so provisioning is
 * fully ASYNC (`child_process.spawn`, promisified) and best-effort — it must NEVER block the daemon's event
 * loop, exactly like `git/worktrees.ts` `createWorktree`'s async dep-provisioning. The SPAWN HOT PATH only
 * ever does a synchronous `fs.existsSync(loomVenvBin(...))` (instant); the heavy provisioning runs in the
 * background via {@link ensurePythonPackageAsync}. There is NO synchronous provisioning surface — a blocking
 * `spawnSync` venv-create/pip on the spawn path was the freeze-the-daemon bug this module exists to avoid.
 *
 * `ensurePythonPackageAsync` is the reusable surface a Python-backed capability calls (off the hot path) to
 * provision + resolve a venv console script. Everything is BOUNDED (spawn timeouts), IDEMPOTENT (a ready
 * venv hits a fast path), and NEVER throws — a failure resolves to `null` and the caller degrades (warn +
 * skip).
 */
export function loomVenvDir(): string {
  return path.join(LOOM_HOME, "python", "venv");
}

/**
 * The ABSOLUTE path to a console script inside the shared venv — `…/Scripts/<bin>.exe` (win32) or
 * `…/bin/<bin>` (posix). PURE (platform-parameterized for the unit test); does NOT touch the filesystem.
 * The absolute path is the load-bearing bit: node-pty's Windows agent does NOT search %PATH%, so the MCP
 * spawn must be handed a fully-qualified command (the same lesson as the claude/Playwright invariant). The
 * spawn hot path resolves a tool by `fs.existsSync(loomVenvBin(<bin>))` — instant, no child process.
 */
export function loomVenvBin(binaryName: string, platform: NodeJS.Platform = process.platform): string {
  const dir = loomVenvDir();
  return platform === "win32"
    ? path.join(dir, "Scripts", `${binaryName}.exe`)
    : path.join(dir, "bin", binaryName);
}

/** The venv's OWN python interpreter (used for `-m pip install` + the import probe). */
function venvPython(platform: NodeJS.Platform = process.platform): string {
  const dir = loomVenvDir();
  return platform === "win32"
    ? path.join(dir, "Scripts", "python.exe")
    : path.join(dir, "bin", "python");
}

/** Bound (ms) for the quick `--version` / `import` probes. */
const PROBE_TIMEOUT_MS = 15_000;
/** Bound (ms) for `python -m venv` (fast — just unpacks a fresh env). */
const VENV_CREATE_TIMEOUT_MS = 120_000;
/**
 * Default bound (ms) for `pip install` — far larger than a venv create because a first-time install
 * (e.g. `markitdown[all]`) downloads wheels. Mirrors the worktree provisioning bound; callers override
 * via `ensurePythonPackageAsync({ timeoutMs })`. On timeout the child is killed and we degrade to `null`.
 */
const PIP_INSTALL_TIMEOUT_MS = 180_000;

/** A base-Python invocation: the command plus any fixed leading args (e.g. the `py -3` launcher). */
export interface BasePython {
  command: string;
  args: string[];
}

/**
 * Run a child process to completion ASYNCHRONOUSLY (never blocks the event loop), resolving `{ ok }`:
 * `ok` is true iff the process exited 0 within `timeoutMs`. NEVER rejects — a spawn error, non-zero exit,
 * or timeout all resolve `{ ok: false }` (best-effort, the worktree-provisioning discipline). stdio ignored.
 */
function runAsync(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; resolve({ ok }); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: "ignore" });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } finish(false); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish(false); });
    child.on("exit", (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/**
 * Find a usable BASE Python interpreter to CREATE the shared venv, trying candidates in order:
 *   1. the human-only `python.interpreterPath` override (passed in), when set;
 *   2. `python3`;
 *   3. `python`;
 *   4. (win32 only) the `py -3` launcher.
 * The FIRST whose `--version` exits 0 wins. Returns its `{ command, args }`, or `null` when none works (the
 * user must install a base Python / point `python.interpreterPath` at one). ASYNC + bounded + never throws.
 * Run via `spawn` (which DOES search %PATH%), so a bare name is fine — only the resulting venv binary handed
 * to node-pty must be absolute, and {@link loomVenvBin} already returns an absolute path.
 */
export async function discoverBasePythonAsync(override?: string): Promise<BasePython | null> {
  const candidates: BasePython[] = [];
  if (override && override.trim()) candidates.push({ command: override, args: [] });
  candidates.push({ command: "python3", args: [] }, { command: "python", args: [] });
  if (process.platform === "win32") candidates.push({ command: "py", args: ["-3"] });
  for (const c of candidates) {
    const r = await runAsync(c.command, [...c.args, "--version"], PROBE_TIMEOUT_MS);
    if (r.ok) return c;
  }
  return null;
}

/**
 * Ensure the shared venv exists, returning the ABSOLUTE path to its python interpreter, or `null` if it
 * can't be created (no base Python, or `python -m venv` failed). Idempotent: if the venv python is already
 * present this is a fast no-op. ASYNC + bounded + never throws. Loom creates ONLY the venv — never the
 * interpreter.
 */
async function ensureLoomVenvAsync(interpreterOverride?: string): Promise<string | null> {
  const py = venvPython();
  if (fs.existsSync(py)) return py; // fast path: already provisioned
  const base = await discoverBasePythonAsync(interpreterOverride);
  if (!base) return null;
  try {
    fs.mkdirSync(path.dirname(loomVenvDir()), { recursive: true }); // `python -m venv` makes the leaf, not parents
  } catch {
    /* best-effort */
  }
  const r = await runAsync(base.command, [...base.args, "-m", "venv", loomVenvDir()], VENV_CREATE_TIMEOUT_MS);
  if (!r.ok) return null;
  return fs.existsSync(py) ? py : null;
}

export interface EnsurePythonPackageOpts {
  /** pip install target(s) — a single spec (`"markitdown-mcp"`) or several (`["markitdown-mcp", "markitdown[all]"]`). */
  package: string | string[];
  /** The console-script name the package installs (resolved to an absolute path via {@link loomVenvBin}). */
  binary: string;
  /** Optional module name for a functional import probe (`python -c "import <module>"`) — catches a half-built install. */
  probeImport?: string;
  /** Bound (ms) for the pip install. Default {@link PIP_INSTALL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Human-only base-Python override (`python.interpreterPath`) forwarded to {@link discoverBasePythonAsync}. */
  interpreterOverride?: string;
}

/**
 * THE reusable surface a Python-backed Loom capability calls — OFF the event-loop hot path (e.g. from a
 * background provisioning job) — to resolve an ABSOLUTE path to a console script in the shared venv,
 * provisioning the venv + pip-installing the package on first use. Returns the absolute binary path, or
 * `null` if anything fails (no base Python, venv/pip failure, install produced no functional binary) — the
 * caller then degrades (warn + skip the feature) rather than crashing.
 *
 * Fast path: if the binary already exists and the optional import probe passes, returns immediately (no
 * venv/pip work). ASYNC, idempotent, bounded (every spawn has a timeout), and never throws.
 *
 * TEST/ops seam: `LOOM_PYTHON_NO_PROVISION=1` makes this NEVER create a venv or run pip (it only ever
 * resolves an already-present binary) — so CI hermetic tests can exercise the not-ready path without
 * building a real venv or hitting the network, and an operator can forbid Loom from provisioning venvs.
 */
export async function ensurePythonPackageAsync(opts: EnsurePythonPackageOpts): Promise<string | null> {
  try {
    const bin = loomVenvBin(opts.binary);

    const probeOk = async (py: string): Promise<boolean> => {
      if (!fs.existsSync(bin)) return false;
      if (!opts.probeImport) return true;
      const r = await runAsync(py, ["-c", `import ${opts.probeImport}`], PROBE_TIMEOUT_MS);
      return r.ok;
    };

    // Fast path: a ready venv already has a functional binary — nothing to do (works even when provisioning
    // is disabled, so a pre-warmed venv is always usable).
    if (await probeOk(venvPython())) return bin;

    // Provisioning disabled (tests / ops) → never build a venv or hit the network.
    if (process.env.LOOM_PYTHON_NO_PROVISION === "1") return null;

    const venvPy = await ensureLoomVenvAsync(opts.interpreterOverride);
    if (!venvPy) return null;
    // The venv may have pre-existed without this package (or with it) — re-check before installing.
    if (await probeOk(venvPy)) return bin;

    const pkgs = Array.isArray(opts.package) ? opts.package : [opts.package];
    const r = await runAsync(venvPy, ["-m", "pip", "install", ...pkgs], opts.timeoutMs ?? PIP_INSTALL_TIMEOUT_MS);
    if (!r.ok) return null;
    return (await probeOk(venvPy)) ? bin : null;
  } catch {
    return null; // belt-and-suspenders: this surface NEVER throws
  }
}
