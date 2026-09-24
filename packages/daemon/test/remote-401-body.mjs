import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b855c37d — the trust-tier wall's remote 401 carries a machine-readable `code` + `hint`, additively:
// `error` stays byte-identical ("unauthorized") so every existing string-matcher keeps working.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject, like trust-tier.mjs).
//   1. remote, NO token         → 401 {error:"unauthorized", code:"gateway-token-required", hint:<string>}
//   2. remote, WRONG token      → same body shape (no oracle: absent and wrong are indistinguishable)
//   3. remote, VALID token      → passes through (no 401 body)
//   4. the hint reveals nothing beyond a 401 already does: it never echoes the presented token, names no
//      file path/secret/host detail, and the body's key set is EXACTLY {error, code, hint}.
//   5. the LOOPBACK-secret guard's 401 is untouched: a loopback caller never gets this body.
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-remote-401-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45343";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GOOD_TOKEN = "test-valid-gateway-token";
const REMOTE = "203.0.113.7";
const db = new Db(path.join(TMP, "loom.db"));
db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "0.0.0.0" } });
const app = await buildServer({
  db, pty: {}, sessions: {}, mcp: {}, orchMcp: {},
  platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
  requestShutdown: () => {},
  verifyGatewayToken: (token) => token === GOOD_TOKEN,
});
try {
  const noToken = await app.inject({ method: "GET", url: "/api/projects", remoteAddress: REMOTE });
  const body = noToken.json();
  check("(1) remote no-token → 401", noToken.statusCode === 401);
  check("(1) error is byte-identical \"unauthorized\"", body.error === "unauthorized");
  check("(1) code is \"gateway-token-required\"", body.code === "gateway-token-required");
  check("(1) hint is a non-empty string", typeof body.hint === "string" && body.hint.length > 0);
  check("(4) body key set is EXACTLY {error, code, hint}", JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["code", "error", "hint"]));

  const SECRET_LOOKING = "presented-wrong-token-xyz";
  const wrong = await app.inject({ method: "GET", url: "/api/projects", remoteAddress: REMOTE, headers: { authorization: `Bearer ${SECRET_LOOKING}` } });
  const wrongBody = wrong.json();
  check("(2) remote wrong-token → 401 with the identical body (no absent-vs-wrong oracle)",
    wrong.statusCode === 401 && JSON.stringify(wrongBody) === JSON.stringify(body));
  check("(4) the hint never echoes a presented token", !JSON.stringify(wrongBody).includes(SECRET_LOOKING));
  check("(4) the hint names no filesystem path / loopback secret file / `loom open` pointer",
    !/gateway-loopback|loom open|[\\/]/.test(body.hint) && !/secret/i.test(body.hint));

  const good = await app.inject({ method: "GET", url: "/api/projects", remoteAddress: REMOTE, headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
  check("(3) remote valid token → not 401", good.statusCode !== 401);

  const loopback = await app.inject({ method: "GET", url: "/api/projects" });
  check("(5) loopback caller never sees the gateway-token 401", loopback.statusCode !== 401);
} finally {
  await app.close();
  db.close();
}

await finishAndExit(failures === 0 ? 0 : 1);
