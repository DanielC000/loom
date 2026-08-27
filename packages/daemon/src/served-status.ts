import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { resolveWebDistDir } from "./paths.js";
import { loomVersion } from "./version.js";
import { computeDeployStaleness, readBuildInfo, type DeployStalenessResult } from "./deploy-staleness.js";
import { skillStoreStaleness, type SkillStoreStaleness } from "./skills/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Card 119fd301 — ADJACENT OBSERVATION, recorded but not (yet) worth a code change: this `__dirname` and
 * `deploy-staleness.ts`'s own `path.dirname(distEntryOverride ?? path.join(__dirname, "index.js"))` are
 * TWO INDEPENDENTLY RESOLVED paths that agree only by construction — both compile to the same flat
 * `packages/daemon/dist` today. `distBuiltSha` (read there) vs `processBuiltSha` (captured here) is a
 * comparison BETWEEN them; if the build ever emitted either file into a subdirectory, the two would
 * silently describe different dirs and `distBuiltShaDiffersFromProcess` would fire spuriously or not at
 * all. Worth knowing before "just move this file" looks like a safe, purely-organizational change.
 */

/**
 * Card f26339d7, AMENDMENT 1 — the git commit sha (+ dirty flag) THIS PROCESS is actually executing,
 * captured EXACTLY ONCE, at MODULE LOAD (not at first use — see `deploy-staleness.ts`'s own module doc for
 * why that distinction is the whole point), from this compiled module's OWN directory (`served-status.js`
 * is a sibling of `index.js` in `packages/daemon/dist`, so `__dirname` here IS the daemon's real dist dir
 * in production — no override needed for that part). Node imports this module's code once and never
 * re-reads it off disk again; `build-info.json` is a sidecar to that SAME code and is read with the SAME
 * "once, at load" contract, so these values correctly continue to report the OLD build after a rebuild
 * that lands without a restart, never the new on-disk one.
 * ⚠️ Do NOT wrap this in a function that `buildServedStatus` calls — that would turn it into a per-call
 * FRESH read again and silently reintroduce the exact race this amendment exists to prevent (see
 * `deploy-staleness.ts`'s module doc: a value that can be wrong depending on WHEN it's first read is not a
 * baked signal, it's a race). It must stay a bare top-level assignment, evaluated exactly once, full stop.
 */
const processBuiltInfo = readBuildInfo(__dirname);
let processBuiltSha: string | null = processBuiltInfo.sha;
let processBuiltDirty: boolean | null = processBuiltInfo.dirty;

/** TEST SEAM — a real process re-import isn't available to a unit test the way it is to a genuine
 * restart, so this is the explicit door `deploy-staleness.ts`'s module doc asks for. Production code never
 * calls this. */
export function __setProcessBuiltInfoForTest(sha: string | null, dirty: boolean | null): void {
  processBuiltSha = sha;
  processBuiltDirty = dirty;
}

/**
 * Card 062fa934, Code Review MINOR — the one production read of `computeDeployStaleness()` that carries
 * the captured `processBuiltSha`/`processBuiltDirty` pair (module-level, captured once above), so
 * `buildServedStatus` (the `served_status` tool / `GET /api/deploy-status`) and
 * `SessionService.resumeFleetOnBoot`'s post-restart "your merged code is now live" nudge (sessions/
 * service.ts) read the identical signal rather than two independently-wired calls that could silently
 * drift (e.g. one passing the pair, the other forgetting to and always reading
 * `deploySignatureMismatch: false`). Every other positional param stays at its real-production default
 * (undefined) — see `computeDeployStaleness`'s own doc for what each of those defaults to.
 *
 * NOT the only production caller of `computeDeployStaleness()` — `manager-prompt.ts`'s
 * `composeManagerStartupPrompt` (the `[loom:deploy-stale]` manager-spawn advisory) calls it directly, with
 * no override, and so always reads `deploySignatureMismatch: false`. That is deliberate, not an
 * oversight: that call site only ever reads the mtime-derived `stale`/`commitsBehind`/`runningCodeBuiltAt`
 * fields — it has no use for the signature-mismatch detector this function's captured pair exists to feed,
 * so it was never worth wiring through the same module-level state. If a THIRD caller ever needs
 * `deploySignatureMismatch` too, route it through this function rather than adding a fourth independent
 * `computeDeployStaleness()` call site.
 */
export function currentDeployStaleness(): DeployStalenessResult {
  return computeDeployStaleness({ processBuiltSha, processBuiltDirty });
}

export interface ServedStatus {
  version: string;
  webBundle: string | null;
  uptimeSeconds: number;
  liveSessionCount: number;
  deployStaleness: DeployStalenessResult;
  skillStoreStaleness: SkillStoreStaleness;
}

/**
 * Card f26339d7 — the SINGLE shared composition behind BOTH ways this daemon's own "what am I serving
 * right now" signal is surfaced: the agent-facing MCP tool `served_status` (mcp/orchestration.ts) and the
 * plain, unprivileged, loopback `GET /api/deploy-status` route (gateway/server.ts). A signal readable only
 * from inside an agent session can't be used to check the daemon from OUTSIDE it — exactly the position
 * you're in when the daemon itself is what's under suspicion — so this needs both surfaces, and they must
 * return byte-identical payloads by construction, not by two hand-maintained copies staying in sync by
 * discipline. Both call sites pass their own `db` handle; nothing here is session- or request-scoped.
 */
export function buildServedStatus(db: Db): ServedStatus {
  const webDist = resolveWebDistDir();
  let webBundle: string | null = null;
  try {
    const assetsDir = path.join(webDist, "assets");
    webBundle = fs.readdirSync(assetsDir).find((f) => /^index-.*\.js$/.test(f)) ?? null;
  } catch { /* dist not built / no assets dir — webBundle stays null */ }
  const liveSessionCount = db.listAllSessions().filter((s) => s.processState === "live").length;
  return {
    version: loomVersion(),
    webBundle,
    uptimeSeconds: Math.round(process.uptime()),
    liveSessionCount,
    // Card f26339d7, AMENDMENT 1 / card 062fa934 — `currentDeployStaleness()` reads the SAME
    // module-level, captured-ONCE `processBuiltSha`/`processBuiltDirty` above; see its own doc.
    deployStaleness: currentDeployStaleness(),
    skillStoreStaleness: skillStoreStaleness(),
  };
}
