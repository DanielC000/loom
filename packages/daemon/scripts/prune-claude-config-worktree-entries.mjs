// ─────────────────────────────────────────────────────────────────────────────────────────────
// prune-claude-config-worktree-entries.mjs — ONE-OFF, OWNER-RUN prune (card 498452c0; request e44d319e;
// NOT wired into boot, NOT a REST route, NOT an MCP tool).
//
// WHY: Loom writes one project entry into ~/.claude.json per worker worktree (`ensureTrusted`, pty/
// claude-config.ts) so an unattended `claude` spawn skips the trust dialog. The CLI never revisits or
// removes these, so they accumulate forever (see docs/decisions/498452c0-prune-count-drop-sanity-guard.md
// for the dated census this script was built against). A LIVE worktree's entry is load-bearing (the
// CLI's trust check reads it through an ancestor walk); only an entry whose worktree directory no longer
// exists is a safe prune candidate.
//
// SAFETY
//   * DRY-RUN is the default: it prints the exact dead-entry count plus a capped sample and writes
//     nothing. --apply is required to actually write.
//   * Operates on whatever ~/.claude.json (or <CLAUDE_CONFIG_DIR>/.claude.json) and worktrees root the
//     SAME resolution the live daemon itself uses resolves to (claudeJsonPath / WORKTREES_DIR) — no
//     separate path logic is reimplemented here.
//   * --worktrees-root is a REHEARSAL-ONLY override — card 498452c0 review item 7. It is accepted
//     unconditionally for a dry run; for --apply it is accepted ONLY when CLAUDE_CONFIG_DIR is ALSO
//     explicitly set (the plain signal that this is a deliberate rehearsal against a copy, not a live
//     run against the owner's real config with a mistyped root) — otherwise --apply refuses unless the
//     root resolves to the real WORKTREES_DIR. To rehearse against a copy, set CLAUDE_CONFIG_DIR to a
//     directory holding a copy of your real .claude.json AND pass --worktrees-root pointing at a
//     throwaway directory tree, before running this script with --apply.
//   * Unlike a sqlite-backed backfill, this does NOT require the daemon to be stopped: every write this
//     script makes goes through the SAME cross-process advisory lock every live `ensureTrusted` spawn
//     call already takes on this exact file (in REQUIRED mode for the real write — see
//     pruneDeadWorktreeClaudeConfigEntries's own doc, pty/claude-config.ts), and only ever DELETES a key
//     whose directory is re-verified absent immediately before the write. It is still a bulk, owner-
//     facing mutation of a large project-entry file — read the dry-run output before passing --apply.
//   * Fails closed on a malformed/unreadable config, an unresolvable worktrees root, or an unavailable
//     cross-process lock (card f761fdf3 item 4: most commonly a transient FS error exhausting its own
//     retry budget, or a non-EEXIST open error — not necessarily another process genuinely holding the
//     lock): reports the reason and writes nothing.
//
// RUN (repo root, after `pnpm build`):
//   node packages/daemon/scripts/prune-claude-config-worktree-entries.mjs                 # dry run (prints counts + sample)
//   node packages/daemon/scripts/prune-claude-config-worktree-entries.mjs --apply         # actually prunes
//   node packages/daemon/scripts/prune-claude-config-worktree-entries.mjs --json          # machine-readable result
// ─────────────────────────────────────────────────────────────────────────────────────────────
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.join(here, "..", "dist", p)).href;

const KNOWN_FLAGS = new Set(["--apply", "--json", "--worktrees-root"]);

function printUsageAndExit() {
  console.error("usage: prune-claude-config-worktree-entries.mjs [--apply] [--json] [--worktrees-root <dir>]");
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!KNOWN_FLAGS.has(a)) printUsageAndExit();
    if (a === "--worktrees-root") i++; // consume its value
  }
  const flag = (n) => argv.includes(n);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

  const { pruneDeadWorktreeClaudeConfigEntries, claudeJsonPath } = await import(dist("pty/claude-config.js"));
  const { WORKTREES_DIR } = await import(dist("paths.js"));

  const worktreesRootOverride = val("--worktrees-root");
  const apply = flag("--apply");
  const asJson = flag("--json");

  // Review item 7: --worktrees-root is a rehearsal override, never a live-run footgun. A dry run always
  // accepts it (nothing is written either way). --apply accepts it when it's a no-op (resolves to the
  // SAME path the live daemon itself would use) or when the RESOLVED config path is genuinely NOT the
  // owner's real ~/.claude.json — otherwise it refuses.
  //
  // Card f761fdf3 item 1: compare the RESOLVED claudeJsonPath() against the real ~/.claude.json
  // (os.homedir()), never "is CLAUDE_CONFIG_DIR merely set" — claudeJsonPath() treats
  // CLAUDE_CONFIG_DIR="" as UNSET (falls back to the real file), so an env-is-set check alone would wave
  // through `CLAUDE_CONFIG_DIR= node … --apply --worktrees-root <typo>` straight at the real file.
  //
  // @decision f761fdf3 — never compare with a bare path.resolve(...) === path.resolve(...): it's
  // case-sensitive on win32 and a differently-cased spelling of the real home would wave --apply through
  // against the real file. Always resolve + lower-case on win32 before comparing.
  const normalizeForConfigCompare = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  let worktreesRoot = WORKTREES_DIR;
  if (worktreesRootOverride !== undefined) {
    const isNoop = path.resolve(worktreesRootOverride) === path.resolve(WORKTREES_DIR);
    const isRealConfig = normalizeForConfigCompare(claudeJsonPath()) === normalizeForConfigCompare(path.join(os.homedir(), ".claude.json"));
    const isRehearsal = !apply || isNoop || !isRealConfig;
    if (!isRehearsal) {
      console.error(`REFUSED: --worktrees-root was given with --apply but neither equals the real worktrees root nor targets a config file other than the real ~/.claude.json — this looks like a live run against the real config with an overridden root, not a rehearsal. Set CLAUDE_CONFIG_DIR to a non-default directory to rehearse against a copy, or drop --worktrees-root to prune the real ${WORKTREES_DIR}.`);
      process.exitCode = 1;
      return;
    }
    worktreesRoot = worktreesRootOverride;
  }

  const result = pruneDeadWorktreeClaudeConfigEntries({ dryRun: !apply, worktreesRoot });

  if (asJson) {
    console.log(JSON.stringify({ claudeJson: claudeJsonPath(), worktreesRoot, ...result }, null, 2));
    return;
  }

  console.log(`config file : ${claudeJsonPath()}`);
  console.log(`worktrees root: ${worktreesRoot}`);
  console.log(`mode        : ${result.dryRun ? "dry-run (nothing written)" : "apply"}`);

  if (result.parseError) {
    console.error(`REFUSED: ${result.parseError} — nothing was written.`);
    process.exitCode = 1;
    return;
  }
  if (result.aborted === "worktrees-root-missing") {
    console.error(`REFUSED: worktrees root ${worktreesRoot} does not stat as an existing directory. Nothing was read or written.`);
    process.exitCode = 1;
    return;
  }
  if (result.aborted === "lock-unavailable") {
    console.error("REFUSED: could not acquire the cross-process config lock — either another writer genuinely holds it, or an internal FS error (not necessarily contention) exhausted its own retry budget. Nothing was written. Re-run once the daemon/another prune is idle.");
    process.exitCode = 1;
    return;
  }
  if (result.aborted === "count-drop") {
    console.error("REFUSED: a project entry vanished between this run's two reads without being classified dead by this run. This can be BENIGN — e.g. a concurrent daemon GC (removeClaudeConfigEntryForWorktree) removed an entry whose worktree was deleted and GC'd in the window between this run's two reads — or it can mean the file was truncated or clobbered by something else mid-run. Nothing was written. Re-run once you've confirmed the file is stable.");
    process.exitCode = 1;
    return;
  }

  console.log(`dead entries found (worktree directory absent): ${result.deadCount}`);
  if (result.deadKeysSample.length > 0) {
    console.log(`sample (up to ${result.deadKeysSample.length} of ${result.deadCount}):`);
    for (const k of result.deadKeysSample) console.log(`  ${k}`);
  }
  if (result.unknownKeys.length > 0) {
    // Card f761fdf3 item 6c: mirror deadKeysSample's own cap (50) rather than dumping an unbounded list.
    const UNKNOWN_KEYS_PRINT_CAP = 50;
    const shown = result.unknownKeys.slice(0, UNKNOWN_KEYS_PRINT_CAP);
    console.log(`\nliveness could NOT be determined for ${result.unknownKeys.length} worktree-scoped entr${result.unknownKeys.length === 1 ? "y" : "ies"} (never deleted — investigate manually; showing up to ${UNKNOWN_KEYS_PRINT_CAP}):`);
    for (const k of shown) console.log(`  ${k}`);
  }

  if (!result.dryRun) {
    console.log(`\nremoved: ${result.removedKeys.length}`);
    if (result.recreatedKeys.length > 0) {
      console.log(`recreated since classification (left untouched, NOT removed): ${result.recreatedKeys.length}`);
      for (const k of result.recreatedKeys) console.log(`  ${k}`);
    }
  } else if (result.deadCount > 0) {
    console.log("\nre-run with --apply to actually remove these.");
  }
}

await main();
