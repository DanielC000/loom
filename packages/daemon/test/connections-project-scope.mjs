import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Project-scoped connections (card f2abce7e, child of a6944e54) — the RESOLUTION-side proof (the
// security-critical half of the DoD; the schema/migration half is connections-project-scope-migration.mjs).
//
// Proves:
//   (1) isConnectionUsableByProject — the trust-boundary predicate itself, truth table.
//   (2) performAuthenticatedRequest (agent-tooling P2, connections/request.ts): a project-scoped connection
//       resolves ONLY when the caller's own projectId matches; a GLOBAL (projectId:null) connection
//       resolves regardless of the caller's project — even though BOTH connections are equally present in
//       the session's own allowlist (`sessionConnections`) in every case here, proving the allowlist alone
//       is NOT the gate — a cross-project session whose profile allowlists a scoped id still resolves
//       NOTHING (fail-closed).
//   (3) buildMcpServers' P4 capability-grant path (pty/host.ts): the SAME real composition index.ts's
//       resolveConnectionSecret uses (getConnectionMetadata + isConnectionUsableByProject + getSecretForUse)
//       is exercised end-to-end — a matching projectId gets the secret injected into the mounted server's
//       env; a mismatched/absent projectId mounts the server WITHOUT the secret (fails closed, exactly like
//       an unresolvable connection).
//   (4) provisionConnection's OPTIONAL scoped-rotation extension: a same-name collision refuses across
//       scopes (global vs scoped, or two different projects) exactly as before f2abce7e, but ROTATES in
//       place when the existing row is already scoped to the EXACT requesting project (api-key only).
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-project-scope.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-connections-project-scope-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const {
  createConnection, getConnectionMetadata, getSecretForUse, isConnectionUsableByProject, provisionConnection,
} = await import("../dist/connections/store.js");
const { performAuthenticatedRequest, __resetConnectionsRateLimitState } = await import("../dist/connections/request.js");
const { buildMcpServers } = await import("../dist/pty/host.js");

const GUARD = { rateLimitMax: 100, rateLimitWindowMs: 60_000, requestTimeoutMs: 5_000, maxResponseBytes: 1_000_000 };
const dbFile = (name) => path.join(tmpHome, name);

try {
  // ============ Part 1 — isConnectionUsableByProject: the predicate itself ============
  {
    check("(1) global connection (null) usable by any project", isConnectionUsableByProject(null, "proj-a"));
    check("(1) global connection (null) usable by NO project (caller undefined)", isConnectionUsableByProject(null, undefined));
    check("(1) global connection (null) usable by NO project (caller null)", isConnectionUsableByProject(null, null));
    check("(1) scoped connection usable by the SAME project", isConnectionUsableByProject("proj-a", "proj-a"));
    check("(1) scoped connection NOT usable by a DIFFERENT project", !isConnectionUsableByProject("proj-a", "proj-b"));
    check("(1) scoped connection NOT usable by a caller with no project (undefined)", !isConnectionUsableByProject("proj-a", undefined));
    check("(1) scoped connection NOT usable by a caller with no project (null)", !isConnectionUsableByProject("proj-a", null));
  }

  // ============ Part 2 — performAuthenticatedRequest: resolution scope enforcement ============
  {
    const db = new Db(dbFile("p2.db"));
    __resetConnectionsRateLimitState();
    const fetchImpl = async () => new Response("ok", { status: 200 });

    const globalConn = createConnection(db, { name: "Global API", host: "api.global.example", authScheme: "bearer", secret: "global-secret" });
    check("(setup) global connection has projectId null", getConnectionMetadata(db, globalConn.id).projectId === null);

    const scopedConn = createConnection(db, { name: "Scoped API", host: "api.scoped.example", authScheme: "bearer", secret: "scoped-secret", projectId: "proj-a" });
    check("(setup) scoped connection has projectId 'proj-a'", getConnectionMetadata(db, scopedConn.id).projectId === "proj-a");

    // Both connections are in the SAME allowlist for every call below — the allowlist never changes.
    // Only the callerProjectId varies, proving the allowlist alone doesn't gate resolution.
    const allowlist = [globalConn.id, scopedConn.id];

    const rGlobalFromA = await performAuthenticatedRequest({ db, fetchImpl }, allowlist, GUARD, { connection: globalConn.id, path: "/x" }, "proj-a");
    check("(2) global connection resolves for a caller in project A", rGlobalFromA.ok === true);
    const rGlobalFromB = await performAuthenticatedRequest({ db, fetchImpl }, allowlist, GUARD, { connection: globalConn.id, path: "/x" }, "proj-b");
    check("(2) global connection ALSO resolves for a caller in a DIFFERENT project B", rGlobalFromB.ok === true);
    const rGlobalNoProject = await performAuthenticatedRequest({ db, fetchImpl }, allowlist, GUARD, { connection: globalConn.id, path: "/x" });
    check("(2) global connection resolves even with NO callerProjectId given (backward-compat default)", rGlobalNoProject.ok === true);

    const rScopedFromA = await performAuthenticatedRequest({ db, fetchImpl }, allowlist, GUARD, { connection: scopedConn.id, path: "/x" }, "proj-a");
    check("(2) scoped connection resolves for a caller in ITS OWN project A", rScopedFromA.ok === true);

    const rScopedFromB = await performAuthenticatedRequest({ db, fetchImpl }, allowlist, GUARD, { connection: scopedConn.id, path: "/x" }, "proj-b");
    check("(2) FAIL-CLOSED: scoped connection resolves NOTHING for a DIFFERENT project B, even though it's in B's session allowlist", rScopedFromB.ok === false);
    check("(2) the rejection doesn't confirm existence (generic 'connection not found', not a scope-specific message)", rScopedFromB.ok === false && rScopedFromB.error === "connection not found");

    const rScopedNoProject = await performAuthenticatedRequest({ db, fetchImpl }, allowlist, GUARD, { connection: scopedConn.id, path: "/x" });
    check("(2) FAIL-CLOSED: scoped connection resolves NOTHING for a caller with NO project at all", rScopedNoProject.ok === false);

    db.close();
  }

  // ============ Part 3 — buildMcpServers' P4 capability-grant path, the SAME resolver composition ============
  {
    const db = new Db(dbFile("p3.db"));
    const scopedConn = createConnection(db, { name: "Scoped Cap Conn", host: "api.scoped2.example", authScheme: "api-key", secret: "cap-secret-xyz", projectId: "proj-a" });

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");
    const SECRET_ENV_VAR = "TEST_SCOPED_SECRET";
    const fixtureRow = {
      id: "cap-1", slug: "test-scoped-cap", name: "Test Scoped Capability", description: "test", transport: "stdio",
      kind: "bundled", provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
      toolAllowlistJson: JSON.stringify(["mcp__test-scoped-cap"]), wantsScratchDir: false, requiresConnection: true,
      secretEnvVar: SECRET_ENV_VAR, createdAt: new Date().toISOString(),
    };

    // The SAME composition index.ts's resolveConnectionSecret uses — a faithful proxy for the production
    // resolver, not a fake stand-in that could drift from the real fail-closed logic.
    const realResolver = (connectionId, projectId) => {
      const meta = getConnectionMetadata(db, connectionId);
      if (!meta || !isConnectionUsableByProject(meta.projectId, projectId ?? null)) return undefined;
      return getSecretForUse(db, connectionId);
    };

    const withMatch = buildMcpServers({
      sessionId: "s-1", port: 4317, role: "worker",
      capabilities: [{ slug: "test-scoped-cap", connectionId: scopedConn.id }],
      capabilityCatalog: [fixtureRow],
      resolveConnectionSecret: realResolver,
      projectId: "proj-a",
    });
    check("(3) matching projectId: the capability mounts", !!withMatch["test-scoped-cap"]);
    check("(3) matching projectId: the secret rides the mounted server's env", withMatch["test-scoped-cap"]?.env?.[SECRET_ENV_VAR] === "cap-secret-xyz");

    const withMismatch = buildMcpServers({
      sessionId: "s-2", port: 4317, role: "worker",
      capabilities: [{ slug: "test-scoped-cap", connectionId: scopedConn.id }],
      capabilityCatalog: [fixtureRow],
      resolveConnectionSecret: realResolver,
      projectId: "proj-b",
    });
    check("(3) FAIL-CLOSED: mismatched projectId: the capability still mounts (fixture has no other gate)", !!withMismatch["test-scoped-cap"]);
    check("(3) FAIL-CLOSED: mismatched projectId: NO secret rides the env (undefined, not the real value)", withMismatch["test-scoped-cap"]?.env?.[SECRET_ENV_VAR] === undefined);

    const withNoProject = buildMcpServers({
      sessionId: "s-3", port: 4317, role: "worker",
      capabilities: [{ slug: "test-scoped-cap", connectionId: scopedConn.id }],
      capabilityCatalog: [fixtureRow],
      resolveConnectionSecret: realResolver,
      // projectId omitted entirely — mirrors a platform-tier/project-less session.
    });
    check("(3) FAIL-CLOSED: no projectId at all: NO secret rides the env", withNoProject["test-scoped-cap"]?.env?.[SECRET_ENV_VAR] === undefined);

    db.close();
  }

  // ============ Part 4 — provisionConnection's optional scoped-rotation extension ============
  {
    const db = new Db(dbFile("p4.db"));

    // (a) a GLOBAL existing row still refuses a same-name provision, even with a projectId given —
    // rotation only ever applies when the EXISTING row is already scoped to the exact requesting project.
    provisionConnection(db, { name: "Rotates", host: "h.example", secret: "first-secret" }); // global
    let threwGlobalCollision = false;
    try { provisionConnection(db, { name: "Rotates", host: "h.example", secret: "second-secret", projectId: "proj-a" }); }
    catch { threwGlobalCollision = true; }
    check("(4a) a GLOBAL existing row still refuses a same-name provision from a scoped caller", threwGlobalCollision);

    // (b) an existing row scoped to project A refuses a same-name provision from project B.
    provisionConnection(db, { name: "Scoped To A", host: "h2.example", secret: "a-secret", projectId: "proj-a" });
    let threwCrossProjectCollision = false;
    try { provisionConnection(db, { name: "Scoped To A", host: "h2.example", secret: "b-secret", projectId: "proj-b" }); }
    catch { threwCrossProjectCollision = true; }
    check("(4b) an existing row scoped to project A refuses a same-name provision from project B", threwCrossProjectCollision);
    check("(4b) project A's row is untouched by the refused cross-project attempt", getSecretForUse(db, db.getConnectionByName("Scoped To A").id) === "a-secret");

    // (c) an existing row scoped to project A ROTATES in place for a same-name provision from project A ITSELF.
    const beforeRotate = db.getConnectionByName("Scoped To A");
    const rotated = provisionConnection(db, { name: "Scoped To A", host: "h2.example", secret: "a-secret-ROTATED", projectId: "proj-a" });
    check("(4c) scoped rotation returns the SAME connection id (no duplicate row)", rotated.id === beforeRotate.id);
    check("(4c) scoped rotation's secret is the NEW value", getSecretForUse(db, rotated.id) === "a-secret-ROTATED");
    check("(4c) scoped rotation preserves the project scope", rotated.projectId === "proj-a");
    check("(4c) scoped rotation did not create a second row", db.listConnections().filter((c) => c.name === "Scoped To A").length === 1);

    // (d) a same-scope collision against a NON-api-key row (e.g. oauth2) still refuses — never overwrites
    // an oauth2 token-bundle blob with a plain api-key envelope (the original failure mode this guards).
    const { createOAuthConnection } = await import("../dist/connections/store.js");
    createOAuthConnection(db, {
      name: "OAuth Scoped", host: "oauth.example", provider: "custom", clientId: "cid", clientSecret: "csec",
      authUrl: "https://oauth.example/authorize", tokenUrl: "https://oauth.example/token", scopes: [], projectId: "proj-a",
    });
    let threwOAuthCollision = false;
    try { provisionConnection(db, { name: "OAuth Scoped", host: "oauth.example", secret: "attempted-overwrite", projectId: "proj-a" }); }
    catch { threwOAuthCollision = true; }
    check("(4d) a same-scope collision against an oauth2 row still refuses (never overwrites the token bundle)", threwOAuthCollision);

    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — isConnectionUsableByProject's truth table holds; performAuthenticatedRequest resolves a project-scoped connection ONLY for its own project (fail-closed even when the id is in a cross-project session's own allowlist) while a global connection resolves anywhere; buildMcpServers' P4 capability-grant path (the same real getConnectionMetadata+isConnectionUsableByProject+getSecretForUse composition index.ts uses) injects the secret only on a projectId match and mounts secret-less otherwise; and provisionConnection's optional scoped-rotation extension refuses every cross-scope/cross-project/non-api-key collision while rotating cleanly in place for a same-project same-name api-key row."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
}
process.exit(failures === 0 ? 0 : 1);
