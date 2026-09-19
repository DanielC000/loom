import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e5c82138 — worker `2344c8c8`'s Task-2 evaluation on card `bb267ade` (Code Reviewer `1e7efc4f`'s
// find) surfaced four independent "mask sessionEnv inside a config-shaped object" implementations with
// THREE different empty-record behaviours. This card unifies the three that PROJECT an existing
// config-shaped object — `redactSessionEnvForRead`/`redactSessionEnvHistoryEntry` (gateway/server.ts)
// and `projectFields` (mcp/entityRowFields.ts) — behind ONE shared primitive, `redactSessionEnvInConfig`
// (@loom/shared). `db.ts`'s `recordProjectConfigChange` builds a fresh diff-accumulator rather than
// projecting an existing config, so it does NOT unify — left alone, evaluated inline at its call site
// (see its own `@decision e5c82138` note), and not covered by this file.
//
// THE EMPTY-RECORD POLICY ADOPTED: "preserve" (redactSessionEnvForRead's original behaviour), not
// "drop" (projectFields's pre-fix behaviour) — a pre-existing `sessionEnv: {}` now round-trips as `{}`
// on ALL THREE sites, never silently vanishing. This is the load-bearing behaviour change this file
// exists to prove: `projectFields`'s empty-record case flips from DROP to PRESERVE.
//
// Covers, for EACH of the three unified sites (`redactSessionEnvInConfig` directly, `redactSessionEnvForRead`,
// `redactSessionEnvHistoryEntry` per-leg, and `projectFields`), across three fixtures — a real secret, an
// EMPTY `sessionEnv: {}`, and NO sessionEnv key at all:
//   (1) a real secret is masked (same-length filler, never the plaintext).
//   (2) sibling config keys round-trip untouched.
//   (3) ⭐ THE EMPTY-RECORD EDGE — `sessionEnv: {}` round-trips as a literal `{}` (present, empty),
//       never dropped.
//   (4) an ABSENT sessionEnv key stays absent (no key synthesized where none existed).
//   (5) the underlying stored project's config.sessionEnv is untouched by any of these reads.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like profile-harness-read.mjs: a REAL Db, no
// server, no MCP transport, no daemon — these are pure projection functions called directly.
//
// FALSIFIABILITY (DoD-4): verified by `pnpm --filter @loom/daemon negative-control --file
// packages/daemon/src/mcp/entityRowFields.ts --test packages/daemon/test/sessionenv-config-projection-unify.mjs`
// — reverting ONLY entityRowFields.ts to its pre-fix (HEAD) content, which still drops the key for
// `{}`, turns (3)'s `projectFields` assertion RED while every other assertion here stays GREEN (the
// shared primitive + the two gateway/server.ts sites are unaffected by that revert) — proving this is
// not a vacuous assertion (card bb267ade's own review found exactly that failure mode in this test
// family) but one that actually exercises the fixed empty-record policy.
//
// Run: 1) build (turbo builds shared first), 2) node test/sessionenv-config-projection-unify.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-sessionenv-unify-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { redactSessionEnvInConfig, SESSION_ENV_MASK_CHAR } = await import("@loom/shared");
const { redactSessionEnvForRead, redactSessionEnvHistoryEntry } = await import("../dist/gateway/server.js");
const { projectFields } = await import("../dist/mcp/entityRowFields.js");

const db = new Db();

const REAL_SECRET = "throwaway-not-a-real-credential-unify456";
const now = new Date().toISOString();

db.insertProject({
  id: "pFull", name: "Full", repoPath: tmpHome, vaultPath: tmpHome,
  config: { sessionEnv: { SECRET: REAL_SECRET }, docLint: true },
  createdAt: now, archivedAt: null, reserved: false,
});
db.insertProject({
  id: "pEmpty", name: "Empty", repoPath: tmpHome, vaultPath: tmpHome,
  config: { sessionEnv: {}, docLint: true },
  createdAt: now, archivedAt: null, reserved: false,
});
db.insertProject({
  id: "pAbsent", name: "Absent", repoPath: tmpHome, vaultPath: tmpHome,
  config: { docLint: true }, // no sessionEnv key at all
  createdAt: now, archivedAt: null, reserved: false,
});

const isAllFiller = (s) => s.length > 0 && [...s].every((ch) => ch === SESSION_ENV_MASK_CHAR);

/** Runs the (1)/(2)/(3)/(4) matrix against a `site(fixtureId)` accessor returning a config-shaped object. */
function runMatrix(siteLabel, configOf) {
  const full = configOf("pFull");
  check(`(${siteLabel}) (1) real secret is masked, not plaintext`,
    typeof full.sessionEnv?.SECRET === "string" && full.sessionEnv.SECRET !== REAL_SECRET);
  check(`(${siteLabel}) (1) masked value is same-length filler`,
    full.sessionEnv?.SECRET !== undefined && isAllFiller(full.sessionEnv.SECRET) && full.sessionEnv.SECRET.length === REAL_SECRET.length);
  check(`(${siteLabel}) (2) sibling config key (docLint) round-trips untouched`, full.docLint === true);

  const empty = configOf("pEmpty");
  check(`(${siteLabel}) (3) ⭐ EMPTY-RECORD EDGE: sessionEnv key is PRESENT (not dropped) for a stored {}`,
    "sessionEnv" in empty && empty.sessionEnv !== undefined);
  check(`(${siteLabel}) (3) ⭐ EMPTY-RECORD EDGE: preserved value is a literal empty object`,
    empty.sessionEnv !== undefined && Object.keys(empty.sessionEnv).length === 0);
  check(`(${siteLabel}) (2) sibling config key round-trips untouched on the empty fixture too`, empty.docLint === true);

  const absent = configOf("pAbsent");
  check(`(${siteLabel}) (4) an ABSENT sessionEnv key stays absent (never synthesized)`, !("sessionEnv" in absent));
  check(`(${siteLabel}) (2) sibling config key round-trips untouched on the absent fixture too`, absent.docLint === true);
}

// ===================== (redactSessionEnvInConfig) direct, on the raw stored config =====================
runMatrix("redactSessionEnvInConfig", (id) => redactSessionEnvInConfig(db.getProject(id).config));

// ===================== (redactSessionEnvForRead) the REST read-side wrapper =====================
runMatrix("redactSessionEnvForRead", (id) => redactSessionEnvForRead(db.getProject(id)).config);

// ===================== (redactSessionEnvHistoryEntry) per-leg, on a synthetic history entry =====================
{
  const entryFor = (id) => {
    const config = db.getProject(id).config;
    return redactSessionEnvHistoryEntry({
      id: "hist1", changedKeys: ["sessionEnv"], prior: config, next: config, actor: "human", createdAt: now,
    });
  };
  runMatrix("redactSessionEnvHistoryEntry (prior leg)", (id) => entryFor(id).prior);
  runMatrix("redactSessionEnvHistoryEntry (next leg)", (id) => entryFor(id).next);
}

// ===================== (projectFields) the MCP chokepoint — the load-bearing behaviour CHANGE =====================
runMatrix("projectFields", (id) => projectFields(db.getProject(id)).config);

// ===================== (5) the underlying stored config is untouched by every one of the reads above =====================
check("(5) the STORED pFull.config.sessionEnv is untouched", db.getProject("pFull").config.sessionEnv.SECRET === REAL_SECRET);
check("(5) the STORED pEmpty.config.sessionEnv is still a literal {}", Object.keys(db.getProject("pEmpty").config.sessionEnv).length === 0);
check("(5) the STORED pAbsent.config has no sessionEnv key", !("sessionEnv" in db.getProject("pAbsent").config));

db.close();

console.log(failures === 0
  ? "\n✅ ALL PASS — redactSessionEnvInConfig, redactSessionEnvForRead, redactSessionEnvHistoryEntry (both legs), and projectFields all mask a real secret, round-trip sibling config keys, preserve a literal sessionEnv:{} rather than dropping it, leave an absent sessionEnv key absent, and never mutate the underlying stored config."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
