/**
 * Loom-managed provisioning for a SEED-ONLY "npm-pinned" capability kind (card e7d6e43b): a pinned npm
 * package installed with `npm install --ignore-scripts` into `<LOOM_HOME>/node/<package>/<version>/`.
 * Mirrors `github-binary.ts`'s event-loop discipline exactly: the spawn hot path only ever does a
 * synchronous `fs.existsSync` (see `resolveNpmPinned` in `registry.ts`); the actual install here runs OFF
 * the event loop, in the BACKGROUND, kicked by that resolver on a cold miss. This kind exists so a
 * `bundled`/npx-resolved capability (today: "image-gen") can be migrated onto a kind whose spawn hot path
 * never pays an `npx` re-resolve/download, mirroring the python-venv/github-binary precedent for npm.
 *
 * TRUST + ATOMICITY: `provisionJson` lives in a DB row, so it is constant-AT-SEED-TIME but not
 * compile-time-constant — a hand-edited/corrupted row must never reach the shell, and a killed-mid-install
 * child must never leave a partial tree visible as "ready". `--ignore-scripts` is ALWAYS present (never
 * conditional, never agent/owner-settable) — this is a SEED-ONLY kind (`validateCapabilityDefInput` never
 * accepts it from an owner, same posture as `github-binary`).
 *
 * @decision e7d6e43b — never interpolate a path into the install command string; never skip
 * validateNpmPinnedSpec before building a path or calling existsSync; never install directly into the
 * final `<version>` dir; never kill only the shell on timeout.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { LOOM_HOME } from "../paths.js";
import { killGateProcessTree } from "../orchestration/gate-runner.js";

/** `<LOOM_HOME>/node/<package>/<version>/` — the FINAL (post-install) install dir, version-namespaced so
 *  a version bump lands in a FRESH dir (never overwritten in place), mirrors {@link loomGithubMcpBinDir}.
 *  A scoped package's `@scope/name` slash would otherwise create a nested directory the version segment
 *  doesn't expect — callers always pass an already-validated `package` (see
 *  {@link validateNpmPinnedSpec}), but this function itself stays PURE (no validation, no fs access) so
 *  it's cheap to call from a hot-path resolver. */
export function loomNpmPinnedDir(pkg: string, version: string): string {
  return path.join(LOOM_HOME, "node", pkg, version);
}

/** The ABSOLUTE path to an installed package's own bin script UNDER a given install dir — the package
 *  lands at `<installDir>/node_modules/<package>/`, so this is just that plus the seed-authored
 *  `binRelativeToPackageJson`. PURE (no fs access). Shared by {@link loomNpmPinnedBin} (the FINAL path)
 *  and {@link ensureNpmPinnedAsync}'s own temp-install-dir check, so the two can never compute the bin
 *  path differently. */
function npmPinnedBinUnder(installDir: string, pkg: string, binRelativeToPackageJson: string): string {
  return path.join(installDir, "node_modules", pkg, binRelativeToPackageJson);
}

/** The ABSOLUTE path to the installed package's own bin script inside {@link loomNpmPinnedDir} (the FINAL
 *  path). Mirrors `resolveNodePackage`'s own `binRelativeToPackageJson` convention in `registry.ts`,
 *  applied to an installed-under-LOOM_HOME package instead of an already-installed daemon dependency. */
export function loomNpmPinnedBin(pkg: string, version: string, binRelativeToPackageJson: string): string {
  return npmPinnedBinUnder(loomNpmPinnedDir(pkg, version), pkg, binRelativeToPackageJson);
}

/**
 * Strict ALLOWLIST validation of the three values that get used to build a filesystem path AND
 * interpolated into the `npm install` shell command string — the load-bearing defense-in-depth check (a
 * Code Review finding, card e7d6e43b): the provision recipe is a DB row, not a source literal, so a
 * corrupted/hand-edited row must never reach the shell OR the filesystem unvalidated. Returns a reason
 * string on failure (never throws); `undefined` means every check passed.
 *
 * - `package`: a valid npm package name (scoped `@scope/name` or unscoped `name`) — starts with a letter,
 *   digit, `~`, or (for the scope segment) `@`; the REST of each segment is lowercase letters, digits, and
 *   `. _ ~ -`. A leading `-` is rejected even though `-` is otherwise a valid interior character — `npm
 *   install -foo` would parse `-foo` as a CLI OPTION, not a package name (Code Review finding). Matches
 *   npm's own naming rules closely enough to reject anything shell-special (spaces, quotes, `;`, `&`,
 *   `|`, `$`, backticks, etc. are all outside this charset).
 * - `version`: an EXACT semver (`MAJOR.MINOR.PATCH` plus optional `-prerelease`/`+build`) — explicitly
 *   NOT a range (`^`/`~`/`*`/`x`), a dist-tag (`latest`), a URL, or a `file:`/`git:` spec. Any of those
 *   would let `npm install` resolve to something other than the exact pinned release this kind exists to
 *   guarantee, and some are shell-dangerous on top of that.
 * - `binRelativeToPackageJson`: a relative path with no `..` segment and no leading `/`/`\` — must stay
 *   INSIDE the installed package's own directory (mirrors the containment reasoning in
 *   `resolve-bin.ts`'s `parseNpmCmdShim`, applied to a seed-authored path instead of parsed shim text).
 */
export function validateNpmPinnedSpec(pkg: string, version: string, binRelativeToPackageJson: string): string | undefined {
  // First character excludes '-' (a leading dash would be read as a CLI option by npm itself), but still
  // allows '@' (the scope sigil) — the REST of each segment keeps '-' as a valid interior character.
  const PACKAGE_RE = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;
  const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (typeof pkg !== "string" || !PACKAGE_RE.test(pkg)) {
    return `invalid npm package name '${pkg}' (must be lowercase kebab/scoped, no leading '-', no shell-special characters)`;
  }
  if (typeof version !== "string" || !EXACT_SEMVER_RE.test(version)) {
    return `invalid version '${version}' (must be an EXACT semver — no ranges, dist-tags, URLs, or file:/git: specs)`;
  }
  if (typeof binRelativeToPackageJson !== "string" || binRelativeToPackageJson.length === 0) {
    return "binRelativeToPackageJson must be a non-empty string";
  }
  if (path.isAbsolute(binRelativeToPackageJson) || binRelativeToPackageJson.startsWith("/") || binRelativeToPackageJson.startsWith("\\")) {
    return `binRelativeToPackageJson '${binRelativeToPackageJson}' must be relative (not absolute)`;
  }
  const segments = binRelativeToPackageJson.split(/[/\\]/).filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === "..")) {
    return `binRelativeToPackageJson '${binRelativeToPackageJson}' must not contain a '..' segment`;
  }
  if (binRelativeToPackageJson.includes("\0")) {
    return `binRelativeToPackageJson '${binRelativeToPackageJson}' contains a NUL byte`;
  }
  return undefined;
}

/**
 * The classified outcome of an npm-pinned provisioning attempt:
 *   - `ready`          — the bin resolved (already present, or after a successful atomic install);
 *   - `invalid-spec`   — {@link validateNpmPinnedSpec} rejected `package`/`version`/`binRelativeToPackageJson`
 *                         BEFORE any path was built or anything was interpolated into the shell — nothing
 *                         was ever spawned, and no existsSync check against the (unvalidated) path ever ran;
 *   - `install-failed` — `npm install` exited non-zero, timed out and left no verified install, or
 *                         completed but the expected bin still doesn't exist inside the temp install dir —
 *                         errorTail carries the captured stdout+stderr tail;
 *   - `timeout`        — the install was killed by its bound (the whole process TREE, not just the shell);
 *   - `disabled`       — `LOOM_NPM_PINNED_NO_PROVISION=1` (tests / ops): provisioning was not attempted.
 */
export type NpmPinnedProvisionOutcome = "ready" | "invalid-spec" | "install-failed" | "timeout" | "disabled";

/** Structured result of {@link ensureNpmPinnedAsync}: the resolved absolute bin path (or null) + why. */
export interface EnsureNpmPinnedResult {
  binary: string | null;
  outcome: NpmPinnedProvisionOutcome;
  errorTail?: string;
}

export interface EnsureNpmPinnedOpts {
  package: string;
  version: string;
  binRelativeToPackageJson: string;
  /** Bound (ms) for the install. Default {@link NPM_PINNED_INSTALL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * TEST-ONLY: install this exact npm install-spec instead of `${package}@${version}` — lets a hermetic
   * test install a LOCAL fixture tarball (e.g. an absolute `.tgz` path) through the SAME real
   * `npm install --ignore-scripts` spawn path, with no network dependency. Production code (`registry.ts`'s
   * `resolveNpmPinned`) NEVER sets this — the install-spec is always `${package}@${version}` there. The
   * resolved bin path is still computed from `package`/`version` alone (the installed tarball's own
   * `name`/`version` in its package.json must match, or the bin simply won't exist at the expected path
   * and this classifies as `install-failed` exactly like any other install that doesn't produce the
   * expected bin).
   */
  installSpecOverride?: string;
}

/** Bound (ms) for `npm install` — the installed packages this kind targets are small (no native builds,
 *  `--ignore-scripts` skips any build step anyway), so this is far smaller than markitdown's heavy pip
 *  bound, but still generous for a slow/corporate network. On timeout the child's WHOLE PROCESS TREE is
 *  killed and the outcome is classified `timeout`. */
const NPM_PINNED_INSTALL_TIMEOUT_MS = 180_000;

/** Cap (bytes) on the captured stdout+stderr tail kept for diagnostics — a bounded ring, never the full log. */
const OUTPUT_TAIL_BYTES = 4096;

/** `<LOOM_HOME>/node/.npm-cache` — a Loom-managed, self-contained npm cache for every npm-pinned install,
 *  rather than depending on (or polluting) the ambient global npm cache. Covered by the SAME
 *  `LOOM_HOME_WRITE_DENY_REGISTRY` "node" dir entry every other npm-pinned path already is (paths.ts).
 *  As a side effect this also makes a hermetic test (which already points `LOOM_HOME` at its own temp
 *  dir) fully self-contained for `npm install` too, with no separate test-only env seam needed. */
function npmCacheDir(): string {
  return path.join(LOOM_HOME, "node", ".npm-cache");
}

/** Best-effort sweep of abandoned `.*.tmp-*` install dirs under `parentDir` (card e7d6e43b, Code Review
 *  round 2: a daemon crash, restart, or a failed tree-kill mid-install can leave one behind forever —
 *  nothing else ever revisits it). Removes only an entry matching OUR OWN naming shape (a leading `.`,
 *  containing `.tmp-`) whose mtime is older than `maxAgeMs` — never the final, un-prefixed `<version>`
 *  dir, and never a dir that's still young enough to plausibly be a genuinely in-flight install. Logged,
 *  never throws; a single failed removal doesn't stop the sweep of the rest. */
export function sweepStaleTmpInstallDirs(parentDir: string, maxAgeMs: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(parentDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(".") || !name.includes(".tmp-")) continue;
    const full = path.join(parentDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.lstatSync(full).mtimeMs;
    } catch {
      continue; // already gone, or unreadable — nothing to sweep
    }
    if (now - mtimeMs < maxAgeMs) continue; // young enough to plausibly still be in-flight
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[npm-pinned] failed to sweep stale tmp install dir ${full}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** TEST SEAM: swap node:child_process.spawn — lets a hermetic test drive the real `npm install` spawn
 *  shape (shell:true, bounded, output-captured) against a fake child with no real process or network.
 *  Mirrors `python/venv.ts`'s own `__setSpawnForTest` seam. */
type SpawnFn = typeof spawn;
let spawnImpl: SpawnFn = spawn;
export function __setSpawnForTest(fn?: SpawnFn): void { spawnImpl = fn ?? spawn; }

/** TEST SEAM: swap the process-TREE kill-on-timeout implementation — lets a hermetic test prove the
 *  timeout path without actually spawning `taskkill`/signalling a real process group, and lets it model
 *  "the tree survived the kill attempt anyway" (the exact Windows orphan hazard a Code Review flagged)
 *  without needing a genuinely un-killable child. Defaults to the real, shared `killGateProcessTree`
 *  (orchestration/gate-runner.ts) — the SAME tree-killer `git/bounded.ts` already reuses, rather than a
 *  second hand-rolled kill-by-pid/image-name implementation. */
type KillTreeFn = (child: ChildProcess) => Promise<void>;
let killTreeImpl: KillTreeFn = killGateProcessTree;
export function __setKillTreeForTest(fn?: KillTreeFn): void { killTreeImpl = fn ?? killGateProcessTree; }

/** Run `npm install` to completion ASYNCHRONOUSLY (never blocks the event loop), capturing a bounded
 *  stdout+stderr tail. NEVER rejects — a spawn error, non-zero exit, or timeout all resolve `ok:false`
 *  (mirrors `python/venv.ts`'s `runAsync` / `github-binary.ts`'s `runChildAsync`). `shell:true` (Windows
 *  `npm.cmd`) + a single hardcoded command STRING, and the timeout killing the WHOLE process tree via
 *  {@link killTreeImpl} (never just the shell) — see this file's module doc (the e7d6e43b decision record
 *  it cites) for why both are load-bearing. Settles on `"close"`, not `"exit"` (mirrors `gate-runner.ts`'s own runner)
 *  — `"exit"` can fire before a child's buffered stdio (npm's own trailing `npm error` lines) has fully
 *  flushed, which would leave `errorTail` missing the actual failure reason. */
function runNpmInstallAsync(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
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
    const finish = (ok: boolean): void => { if (!settled) { settled = true; resolve({ ok, timedOut, output: tail() }); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(command, {
        cwd, shell: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "1", npm_config_cache: npmCacheDir() },
        detached: process.platform !== "win32",
      });
    } catch {
      finish(false);
      return;
    }
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      killTreeImpl(child).catch(() => { /* best-effort */ }).finally(() => finish(false));
    }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish(false); });
    child.on("close", (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/**
 * THE reusable surface `resolveNpmPinned` (registry.ts) calls OFF the event-loop hot path (from a
 * background provisioning job) to resolve an ABSOLUTE path to a pinned npm package's bin — installing it
 * with `npm install --ignore-scripts` into the per-package/version `<LOOM_HOME>/node/<package>/<version>/`
 * dir on first use. Mirrors `ensureGithubMcpBinaryAsync`'s shape/discipline: ASYNC (never blocks),
 * IDEMPOTENT (a fast `fs.existsSync` short-circuit), BOUNDED (the install has a timeout), and NEVER
 * THROWS — always resolves a CLASSIFIED {@link EnsureNpmPinnedResult}. Validates BEFORE building any
 * path; installs into a temp sibling dir and renames atomically into place as the LAST step, sweeping any
 * abandoned sibling from a prior crashed/killed attempt first — see this file's module doc (the e7d6e43b
 * decision record it cites) for the full ordering/atomicity/tree-kill rationale.
 *
 * TEST/ops seam: `LOOM_NPM_PINNED_NO_PROVISION=1` makes this NEVER install (only ever resolves an
 * already-present bin, else `disabled`) — mirrors `LOOM_GITHUB_MCP_NO_PROVISION`/`LOOM_PYTHON_NO_PROVISION`.
 */
export async function ensureNpmPinnedAsync(opts: EnsureNpmPinnedOpts): Promise<EnsureNpmPinnedResult> {
  try {
    const invalid = validateNpmPinnedSpec(opts.package, opts.version, opts.binRelativeToPackageJson);
    if (invalid) return { binary: null, outcome: "invalid-spec", errorTail: invalid };

    const finalDir = loomNpmPinnedDir(opts.package, opts.version);
    const bin = npmPinnedBinUnder(finalDir, opts.package, opts.binRelativeToPackageJson);
    if (fs.existsSync(bin)) return { binary: bin, outcome: "ready" };
    if (process.env.LOOM_NPM_PINNED_NO_PROVISION === "1") return { binary: null, outcome: "disabled" };

    const parentDir = path.dirname(finalDir);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (e) {
      return { binary: null, outcome: "install-failed", errorTail: e instanceof Error ? e.message : String(e) };
    }
    const timeoutMs = opts.timeoutMs ?? NPM_PINNED_INSTALL_TIMEOUT_MS;
    sweepStaleTmpInstallDirs(parentDir, timeoutMs); // best-effort; never ours own fresh tmpDir below
    const tmpDir = path.join(parentDir, `.${opts.version}.tmp-${crypto.randomBytes(6).toString("hex")}`);
    const cleanupTmp = (): void => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch (e) {
      return { binary: null, outcome: "install-failed", errorTail: e instanceof Error ? e.message : String(e) };
    }

    const installSpec = opts.installSpecOverride ?? `${opts.package}@${opts.version}`;
    // No path is interpolated here — `--prefix .` names the cwd (set below to tmpDir) literally, never
    // through the shell's own %VAR%/$/backtick parsing. installSpec is the only interpolated value, and
    // it was already validated above (or, for the test-only override, is a Loom-authored absolute path).
    const command = `npm install --ignore-scripts --no-audit --no-fund --no-save "${installSpec}" --prefix .`;
    const r = await runNpmInstallAsync(command, tmpDir, timeoutMs);
    if (!r.ok) {
      cleanupTmp();
      return { binary: null, outcome: r.timedOut ? "timeout" : "install-failed", errorTail: r.output || undefined };
    }

    const tmpBin = npmPinnedBinUnder(tmpDir, opts.package, opts.binRelativeToPackageJson);
    if (!fs.existsSync(tmpBin)) {
      cleanupTmp();
      return { binary: null, outcome: "install-failed", errorTail: r.output || "install exited 0 but the expected bin does not exist" };
    }

    // ATOMIC — the hot path's fs.existsSync(bin) against the FINAL path (registry.ts) can only ever
    // observe a FULLY installed tree, never a partial one. A pre-existing finalDir here means a
    // pre-this-fix partial install, or a genuine race — the per-slug dedupe (kickCapabilityProvision)
    // only ever prevents TWO SLUGS that share the same slug string from racing; it does NOT key on
    // package@version, so two DIFFERENT slugs seeded against the SAME package@version (not something
    // Loom's own seed data does today — only "image-gen" uses this kind) could still both call this
    // function concurrently. The removal + rename below just makes that case benign (a wasted duplicate
    // install, last-rename-wins) rather than a rename failure.
    try {
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, finalDir);
    } catch (e) {
      cleanupTmp();
      return { binary: null, outcome: "install-failed", errorTail: e instanceof Error ? e.message : String(e) };
    }
    return fs.existsSync(bin)
      ? { binary: bin, outcome: "ready" }
      : { binary: null, outcome: "install-failed", errorTail: "renamed into place but the expected bin is missing (unexpected)" };
  } catch (e) {
    return { binary: null, outcome: "install-failed", errorTail: e instanceof Error ? e.message : String(e) }; // belt-and-suspenders: this surface NEVER throws
  }
}
