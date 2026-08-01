import path from "node:path";
import type { RepoRegistryEntry } from "@loom/shared";
import { resumeDocSizeWarning, resolveResumeDocPath } from "./resume-doc-notes.js";
import { computeDeployStaleness, type DeployStalenessResult } from "../deploy-staleness.js";

/**
 * PL Auditor finding #8 — inject a small "Where things live" context block (the project's absolute
 * `repoPath` + `vaultPath`, PLUS the fully-resolved resume-doc path) into a MANAGER session's startup
 * prompt at spawn. A cold-boot orchestrator otherwise can't construct its resume-doc path (the daemon
 * knows the vault root, but never tells the agent) and Globs for it — a broad Glob from the user's home
 * hits the 20s ripgrep cap.
 *
 * The block is a PRE-block (context first, then the agent's own doctrine/kickoff) — mirrors how
 * `composeRunStartupPrompt` wraps a run's doctrine + input. PURE-ISH (one guarded `fs.statSync` on the
 * resolved resume-doc path — see below) + exported so the hermetic test can assert the composition.
 * MANAGERS ONLY (lowest blast radius): only `startManager` calls this, so every worker/run/plain/
 * platform/auditor spawn byte-stream is unchanged.
 *
 * The block emits the resume doc as a FULLY-RESOLVED absolute path, built SERVER-SIDE via
 * `resolveResumeDocPath` (`resume-doc-notes.ts`) from the resolved `vaultPath` PLUS the project's
 * `orchestration.resumeDocFilename` config (defaults to `"Orchestrator Log.md"` — Loom's own convention —
 * when unset, so every project that doesn't override it is byte-identical to before). `vaultPath` IS the
 * project's vault directory (e.g. `.../Obsidian Vault/Projects/Loom`) — NOT the vault root. The agent
 * Reads it verbatim with zero derivation, instead of reconstructing the path from memory and mis-spelling
 * the vault root OR assuming a filename that isn't this project's actual convention (card c1f2f095 — both
 * failure modes were observed: a hand-written prompt line AND the generic derivation formula drifted from
 * the real file when a project's resume doc used a non-default name).
 *
 * Card 809cc4b5 — a manager's resume doc grew past the harness Read cap and broke a successor's cold
 * Read. `resumeDocSizeWarning` (`resume-doc-notes.ts` — the SAME check the Platform Lead's resume doc
 * already had) is checked here too, and if the resolved doc is already oversized, its
 * `[loom:resume-doc-size]` note is prepended AHEAD of the pointer block — mirroring
 * `composePlatformLeadStartupPrompt`'s ordering, so a cold-booting successor sees "rotate this" before
 * it's told where to read it. This only covers the spawn/recycle moment; the mid-session case (a doc
 * that grows oversized while its manager stays live, never recycling) is covered separately by
 * `ResumeDocWatcher` (`orchestration/resume-doc-watcher.ts`), which resolves the SAME path via the SAME
 * `resolveResumeDocPath` — one source of truth for both call sites.
 */
export function composeManagerStartupPrompt(
  startupPrompt: string | undefined,
  loc: { repoPath: string; vaultPath: string; name: string; referenceRepos?: string[]; repos?: RepoRegistryEntry[]; resumeDocFilename?: string },
  // Test seam ONLY (card 5e30c4bd) — a real spawn always omits this and gets the live
  // `computeDeployStaleness()` read; a hermetic test injects a fixed result so it can assert BOTH the
  // STALE and CLEAN renderings deterministically, without needing a real git checkout + a rebuilt dist.
  stalenessOverride?: DeployStalenessResult,
): string {
  // A project with no vault bound (`vaultPath === ""` — see shared/types.ts) has no resume doc to
  // resolve: omit both the vault-dir and resume-doc lines entirely rather than feed "" into
  // resolveResumeDocPath (which would resolve it against the DAEMON's own cwd, not fail cleanly).
  const hasVault = !!loc.vaultPath;
  // Card 96c4b245: every write site now rejects a non-absolute vaultPath (projects/vault-path.ts), but
  // an ALREADY-stored legacy row (bound before that guard existed) can still hold a relative value — and
  // there is no recoverable "vault root" Loom could resolve it against (no such config exists anywhere),
  // so guessing one at render time (e.g. `path.resolve` against the daemon's OWN cwd) would fabricate a
  // confidently-wrong absolute path, worse than the relative value it "fixed". Surface the problem
  // instead: skip the vault-dir/resume-doc lines and flag it for a human re-bind.
  const vaultPathInvalid = hasVault && !path.isAbsolute(loc.vaultPath);
  const resumeDoc = hasVault && !vaultPathInvalid ? resolveResumeDocPath(loc.vaultPath, loc.resumeDocFilename) : "";
  const sizeNote = resumeDoc ? resumeDocSizeWarning(resumeDoc) : "";
  const invalidNote = vaultPathInvalid
    ? `[loom:vault-path-invalid] This project's configured vault path (\`${loc.vaultPath}\`) is not an ` +
      `absolute path, so Loom cannot resolve a real vault dir or resume-doc location from it — neither is ` +
      `shown below. This needs a HUMAN to re-bind the project's vault path (project settings) to a real, ` +
      `absolute filesystem path; do not attempt to derive or guess the correct path yourself.`
    : "";
  // Card 5e30c4bd: a daemon-`src`/`shared` commit can be MERGED on mainline for a long time before this
  // daemon PROCESS is restarted to actually run it — and nothing surfaced that gap (the incident: ~1h50m,
  // discovered only because a manager happened to call `served_status` by hand). DERIVED fresh on every
  // manager spawn/resume/recycle (never cached/persisted — see computeDeployStaleness's own doc), scoped
  // to ONLY daemon-src/shared commits so an assets/docs/vault-only merge (no restart needed) never cries
  // wolf. `available:false` (a packaged loomctl install, or the check itself failing) emits nothing —
  // byte-identical to before this card for every non-self-hosting deployment.
  //
  // SYNCHRONOUS by design, not an oversight: `computeDeployStaleness()` runs a bounded `execFileSync` git
  // read directly on this call. That is NOT the `createPty`/`buildSpawnArgs` hot path CLAUDE.md's
  // event-loop discipline protects (the incident that discipline exists for was an UNBOUNDED,
  // minutes-long `spawnSync` — venv create + pip install — on a path EVERY session spawn hits). This
  // function only runs for a MANAGER spawn/resume/recycle, a comparatively rare event, so a bounded git
  // call (worst case 2×`GIT_TIMEOUT_MS` fully-blocked event loop, degrading gracefully on timeout — see
  // that constant's own doc) was judged an acceptable, much simpler alternative to an async-cache-plus-
  // prewarm layer (the `getCachedClaudeVersion` pattern) for this specific, infrequent call site.
  const staleness = stalenessOverride ?? computeDeployStaleness();
  const shortSha = (sha: string) => sha.slice(0, 8);
  // Deliberately EMITS NOTHING when clean (or unavailable) — no "Deploy status: current" line. A quiet
  // reassurance on EVERY manager spawn, forever, is exactly the cry-wolf noise DoD #2 (`637558ca`) warns
  // about: a line that's nearly always present is a line nobody reads, and it breaks byte-identical
  // output for every project unaffected by this feature. The startup block is for the ALARM; a manager
  // wanting positive confirmation already has the full detail via `served_status.deployStaleness`.
  // Card 8ff7ccde: `staleness.distBuiltAt` is an ON-DISK ARTIFACT clock — it can be NEWER than the code
  // this process is actually executing (a rebuild that landed without a restart). Report the EXECUTING
  // clock (`runningCodeBuiltAt`) as "its own", and when the two diverge (`distAheadOfProcess`), say so
  // explicitly rather than silently swapping one number for the other — a manager reading this should be
  // able to tell "rebuilt but not yet running" from "not rebuilt at all".
  const divergenceNote = staleness.distAheadOfProcess
    ? ` (a newer build ALSO exists on disk, dated ${staleness.distBuiltAt}, that this process has not picked up — restarting would additionally pick that up)`
    : "";
  const deployStaleNote = staleness.available && staleness.stale
    ? `[loom:deploy-stale] ⚠️ THIS DAEMON PROCESS IS RUNNING STALE CODE. Mainline HEAD \`${shortSha(staleness.mainlineHeadSha!)}\` ` +
      `(committed ${staleness.mainlineHeadDate}) carries ${staleness.commitsBehind} \`packages/daemon/src\`/\`packages/shared/src\` ` +
      `commit(s) this running process was NOT built with (its own EXECUTING code dates to ${staleness.runningCodeBuiltAt}${divergenceNote}). ` +
      `Those changes are MERGED but NOT LIVE — for EVERY project this shared daemon serves, not just this one. Do not assume a ` +
      `recently-merged daemon fix or feature is actually in effect; a manager holding it can bring it live via \`daemon_restart\`.`
    : "";
  const block =
    "## Where things live (this project's absolute paths)\n" +
    `- **Repo root (your cwd):** \`${loc.repoPath}\`\n` +
    (hasVault && !vaultPathInvalid
      ? `- **Project vault dir:** \`${loc.vaultPath}\`\n- **Resume doc:** \`${resumeDoc}\`\n\n`
      : "\n") +
    "Read project files by ABSOLUTE path from these roots — never Glob from your home directory " +
    "for them (a broad Glob hits the search timeout)." +
    (hasVault && !vaultPathInvalid
      ? " Read your resume doc from the exact absolute path above, verbatim — do not reconstruct it."
      : vaultPathInvalid
      ? " This project's vault path is misconfigured (see the note above) — keep any handoff/progress notes on the board task instead until it's fixed."
      : " This project has no vault bound — there is no resume doc; keep any handoff/progress notes on the board task instead.");
  const blockWithNote = [invalidNote, sizeNote, deployStaleNote, block].filter(Boolean).join("\n\n");
  // Reference-repos epic Phase 3 ("Interpretation A"): additional repos this project's manager may
  // READ but never owns — no worktree/branch/gate exists for them, so they're never a cwd or a merge
  // target. Omitted entirely when the project sets none, so the additive guarantee holds.
  const refs = loc.referenceRepos?.filter((r) => r.trim());
  const refBlock = refs && refs.length > 0
    ? "\n\n**Also referenced (read-only, not your cwd):**\n" +
      refs.map((r) => `- \`${r}\``).join("\n") +
      "\n\nYou may read/inspect these repos, but never commit there — there is no worktree, branch, " +
      "or gate for a reference repo. If a task turns out to need changes IN a reference repo, that's " +
      "out of scope here; surface it instead of committing there."
    : "";
  // Multi-repo epic 49136451, phase 3: the project's WRITABLE repo registry — the repos a manager may
  // actually route cards at (distinct from the read-only reference repos above). Omitted entirely when the
  // project registers none, so a single-repo project's prompt is byte-identical to before this existed.
  //
  // The two facts here are the ones that were previously discoverable nowhere: repoKey is the manager's
  // OWN dispatch lever (a worker cannot set it), and a registered repo's missing gate does NOT inherit
  // this project's gate command — it merges unverified, which is a thing to decide about before
  // dispatching, not to discover at merge time.
  // NOT filtered, deliberately — and this must stay symmetric with the worker's block
  // (`worker-prompt.ts` › `WorkerRepoContext.registry`), which also consumes the registry as-is.
  // `validateRepoRegistry` is the single gate on every write path and already rejects a blank, duplicate,
  // reserved, or non-`[A-Za-z0-9._-]` key, so a defensive blank-key filter here would be dead code that
  // implies the data is untrusted — which then invites the next reader to add the same filter in the two
  // or three other places the registry is read. The reference-repos blocks above DO filter, and that
  // asymmetry is intentional: `referenceRepos` is a bare `string[]`, this is a validated typed record.
  const registry = loc.repos;
  const repoBlock = registry && registry.length > 0
    ? "\n\n**Registered repos (this project is multi-repo):**\n" +
      `- \`primary\` — \`${loc.repoPath}\` (the default target, and your own cwd)\n` +
      registry.map((r) => `- \`${r.key}\` — \`${r.path}\`` + (r.gateCommand ? ` · gate: \`${r.gateCommand}\`` : " · **no gate configured** — merges here report as unverified")).join("\n") +
      "\n\nRoute each card at CREATION time by setting its `repoKey` (`tasks_create`/`tasks_update`); a card " +
      "with no `repoKey` targets `primary`. This is YOUR dispatch decision — a worker cannot set or change " +
      "its own card's repo, so a card routed at the wrong repo stays wrong until you fix it.\n\n" +
      "**One task = one repo.** There is no cross-repo atomic merge, so a change spanning two repos is TWO " +
      "sibling cards you sequence — land the dependency first, then the dependent — never one card. And a " +
      "registered repo with no gate command does NOT inherit this project's gate: work merged there is " +
      "reported unverified, so decide before you dispatch whether that is acceptable for the card."
    : "";
  const full = blockWithNote + refBlock + repoBlock;
  const own = startupPrompt?.trim();
  return own ? `${full}\n\n${own}` : full;
}

/**
 * Append an OPTIONAL per-schedule custom prompt to a session's already-composed startupPrompt, as a
 * clearly-delimited trailing block — never precedes or clobbers the agent's own identity/doctrine (or,
 * for a manager, the "Where things live" pre-block above). Applies uniformly to every schedule kind
 * (manager/auditor/workspace-auditor) — callers pass whatever startupPrompt they'd otherwise spawn with.
 * `prompt` unset/blank ⇒ returns `startupPrompt` untouched, so a schedule with no custom prompt composes
 * BYTE-IDENTICAL to today. PURE + exported so the hermetic test can assert both branches.
 */
export function appendScheduledPrompt(
  startupPrompt: string | undefined,
  prompt: string | null | undefined,
): string | undefined {
  const custom = prompt?.trim();
  if (!custom) return startupPrompt;
  const base = startupPrompt?.trim();
  const block = `Scheduled task:\n${custom}`;
  return base ? `${base}\n\n---\n${block}` : block;
}
