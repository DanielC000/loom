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
 * venv hits a fast path), and NEVER throws — it resolves a CLASSIFIED {@link EnsurePythonResult} (the
 * absolute binary on success, else `{ binary:null, outcome, errorTail? }` naming the specific failure) so the
 * caller can log the real reason + surface it to a status/REST layer, then degrade (warn + skip).
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
 * downloads wheels. Mirrors the worktree provisioning bound; callers override via
 * `ensurePythonPackageAsync({ timeoutMs })` (the markitdown consumer passes a far larger bound because
 * `markitdown[all]` is heavy — onnxruntime + many converters). On timeout the child is killed and the
 * outcome is classified `timeout`.
 */
const PIP_INSTALL_TIMEOUT_MS = 180_000;

/** Cap (bytes) on the captured stdout+stderr tail kept for diagnostics — a bounded ring, never the full log. */
const OUTPUT_TAIL_BYTES = 4096;

/** A base-Python invocation: the command plus any fixed leading args (e.g. the `py -3` launcher). */
export interface BasePython {
  command: string;
  args: string[];
}

/**
 * The classified outcome of a Python provisioning attempt — distinguishing the genuinely-different failure
 * modes that used to be lumped into one opaque "venv/pip failed" message:
 *   - `ready`           — the binary resolved (fast path, or after a successful create + install);
 *   - `no-base-python`  — {@link discoverBasePythonAsync} found no usable base interpreter (≥3.10 on PATH /
 *                         `python.interpreterPath`);
 *   - `venv-create-failed` — `python -m venv` exited non-zero (errorTail carries the captured output);
 *   - `pip-failed`      — `pip install` exited non-zero, or produced no functional binary (errorTail carries
 *                         the captured stderr/stdout tail — the SSL/proxy/resolver reason);
 *   - `timeout`         — a step was killed by its bound (the heavy first install exceeding the pip bound is
 *                         the most likely real-world cause on a corporate network);
 *   - `disabled`        — `LOOM_PYTHON_NO_PROVISION=1` (tests / ops): provisioning was not attempted.
 */
export type ProvisionOutcome =
  | "ready" | "no-base-python" | "venv-create-failed" | "pip-failed" | "timeout" | "disabled";

/** Structured result of {@link ensurePythonPackageAsync}: the resolved absolute binary path (or null) + why. */
export interface EnsurePythonResult {
  /** Absolute path to the venv console script on success; null on any non-`ready` outcome. */
  binary: string | null;
  /** The classified outcome — see {@link ProvisionOutcome}. */
  outcome: ProvisionOutcome;
  /** On a failure that captured child output: the bounded (~4KB) stdout+stderr tail, for diagnosis. */
  errorTail?: string;
}

/** What {@link runAsync} resolves: success flag, exit code, whether the BOUND killed it, and the output tail. */
interface RunResult {
  /** True iff the process exited 0 within `timeoutMs`. */
  ok: boolean;
  /** The exit code (null on spawn error / kill). */
  code: number | null;
  /** True iff the child was KILLED by the timeout bound (distinguishes `timeout` from a plain non-zero exit). */
  timedOut: boolean;
  /** The last {@link OUTPUT_TAIL_BYTES} of combined stdout+stderr, for diagnostics. "" when nothing captured. */
  output: string;
}

/**
 * Run a child process to completion ASYNCHRONOUSLY (never blocks the event loop), resolving a {@link RunResult}.
 * NEVER rejects — a spawn error, non-zero exit, or timeout all resolve `ok:false` (best-effort, the
 * worktree-provisioning discipline). Unlike the old `stdio:'ignore'` version it CAPTURES stdout+stderr into a
 * bounded ring (last ~4KB) so a caller can log/return the REAL failure (proxy / SSL / resolver / timeout)
 * instead of an opaque "it failed". The ring is bounded as output streams in, so a multi-minute verbose pip
 * install can't grow the buffer without limit.
 */
function runAsync(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    // Bounded capture ring: keep roughly the last OUTPUT_TAIL_BYTES, dropping whole chunks off the front as
    // newer ones arrive. The final tail() slices to exactly the cap.
    const chunks: Buffer[] = [];
    let bytes = 0;
    const capture = (b: Buffer): void => {
      chunks.push(b);
      bytes += b.length;
      while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
    };
    const tail = (): string => {
      const s = Buffer.concat(chunks).toString("utf-8").trim();
      return s.length > OUTPUT_TAIL_BYTES ? s.slice(-OUTPUT_TAIL_BYTES) : s;
    };
    const finish = (ok: boolean, code: number | null) => {
      if (!settled) { settled = true; resolve({ ok, code, timedOut, output: tail() }); }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(false, null);
      return;
    }
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* noop */ } finish(false, null); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish(false, null); });
    child.on("exit", (code) => { clearTimeout(timer); finish(code === 0, code); });
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

/** What {@link ensureLoomVenvAsync} resolves: the venv interpreter path on success, else a classified failure. */
interface VenvEnsureResult {
  /** Absolute path to the venv's python on success; null on failure. */
  py: string | null;
  /** `ready` on success, else the specific failure mode. */
  outcome: Extract<ProvisionOutcome, "ready" | "no-base-python" | "venv-create-failed" | "timeout">;
  /** Captured output tail on a venv-create failure. */
  errorTail?: string;
}

/**
 * Ensure the shared venv exists, returning the ABSOLUTE path to its python interpreter, or a CLASSIFIED
 * failure (no base Python / venv-create non-zero / timeout) with the captured output tail. Idempotent: if
 * the venv python is already present this is a fast no-op. ASYNC + bounded + never throws. Loom creates ONLY
 * the venv — never the interpreter.
 */
async function ensureLoomVenvAsync(interpreterOverride?: string): Promise<VenvEnsureResult> {
  const py = venvPython();
  if (fs.existsSync(py)) return { py, outcome: "ready" }; // fast path: already provisioned
  const base = await discoverBasePythonAsync(interpreterOverride);
  if (!base) return { py: null, outcome: "no-base-python" };
  try {
    fs.mkdirSync(path.dirname(loomVenvDir()), { recursive: true }); // `python -m venv` makes the leaf, not parents
  } catch {
    /* best-effort */
  }
  const r = await runAsync(base.command, [...base.args, "-m", "venv", loomVenvDir()], VENV_CREATE_TIMEOUT_MS);
  if (!r.ok) return { py: null, outcome: r.timedOut ? "timeout" : "venv-create-failed", errorTail: r.output || undefined };
  return fs.existsSync(py) ? { py, outcome: "ready" } : { py: null, outcome: "venv-create-failed" };
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
 * provisioning the venv + pip-installing the package on first use. Returns an {@link EnsurePythonResult}:
 * `{ binary, outcome, errorTail? }`. On success `binary` is the absolute path and `outcome` is `ready`; on
 * failure `binary` is null and `outcome` CLASSIFIES why (no base Python / venv-create / pip / timeout /
 * disabled) with the captured output tail — so the caller logs the SPECIFIC reason (and surfaces it to the
 * status/REST layer) instead of an opaque "it failed", and degrades (warn + skip the feature) rather than
 * crashing.
 *
 * Fast path: if the binary already exists and the optional import probe passes, returns `ready` immediately
 * (no venv/pip work). ASYNC, idempotent, bounded (every spawn has a timeout), and never throws.
 *
 * TEST/ops seam: `LOOM_PYTHON_NO_PROVISION=1` makes this NEVER create a venv or run pip (it only ever
 * resolves an already-present binary, else returns `disabled`) — so CI hermetic tests can exercise the
 * not-ready path without building a real venv or hitting the network, and an operator can forbid Loom from
 * provisioning venvs.
 */
export async function ensurePythonPackageAsync(opts: EnsurePythonPackageOpts): Promise<EnsurePythonResult> {
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
    if (await probeOk(venvPython())) return { binary: bin, outcome: "ready" };

    // Provisioning disabled (tests / ops) → never build a venv or hit the network.
    if (process.env.LOOM_PYTHON_NO_PROVISION === "1") return { binary: null, outcome: "disabled" };

    const venv = await ensureLoomVenvAsync(opts.interpreterOverride);
    if (!venv.py) return { binary: null, outcome: venv.outcome, errorTail: venv.errorTail };
    // The venv may have pre-existed without this package (or with it) — re-check before installing.
    if (await probeOk(venv.py)) return { binary: bin, outcome: "ready" };

    const pkgs = Array.isArray(opts.package) ? opts.package : [opts.package];
    const r = await runAsync(venv.py, ["-m", "pip", "install", ...pkgs], opts.timeoutMs ?? PIP_INSTALL_TIMEOUT_MS);
    if (!r.ok) return { binary: null, outcome: r.timedOut ? "timeout" : "pip-failed", errorTail: r.output || undefined };
    // Installed but the import probe still fails → a half-built install; classify as pip-failed.
    return (await probeOk(venv.py)) ? { binary: bin, outcome: "ready" } : { binary: null, outcome: "pip-failed" };
  } catch {
    return { binary: null, outcome: "pip-failed" }; // belt-and-suspenders: this surface NEVER throws
  }
}
