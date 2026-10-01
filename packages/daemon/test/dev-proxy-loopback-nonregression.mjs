import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a3d48a15 — non-regression for the UNCONDITIONAL proxy-shaped-header downgrade: the repo's own `pnpm web` dev proxy
// (packages/web/vite.config.ts, vite's bundled http-proxy) must keep reaching the daemon's REAL loopback port with loopback
// trust. It does because http-proxy only adds X-Forwarded-* when `xfwd` is set, and the config doesn't set it. Two legs
// through a REAL vite dev server + a REAL listening daemon:
//   (A) the repo's real vite.config.ts proxy (no xfwd) -> GET /api/version is 200 (loopback trust preserved);
//   (B) CONTROL, same config plus `xfwd:true` -> 403 code 'proxy-shaped-header' — proving (A)'s 200 is not vacuous (the
//       proxy CAN add the headers, and the daemon DOES refuse when it does).
// HERMETIC + CLAUDE-FREE: own LOOM_HOME, hermetic ports, no network beyond loopback.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { listenHermetic } from "./_hermetic-port.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempManaged("loom-devproxy-");
process.env.LOOM_HOME = TMP;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const webDir = path.resolve(__dirname, "../../web");
const webRequire = createRequire(path.join(webDir, "package.json"));
const viteEntry = path.join(path.dirname(webRequire.resolve("vite/package.json")), "dist/node/index.js");
const vite = await import(pathToFileURL(viteEntry).href);

const stub = {};
const db = new Db(path.join(TMP, "loom.db"));
const app = await buildServer({
  db, pty: stub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
  setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
});
// listenHermetic finalizes LOOM_PORT (read by packages/web/vite.config.ts at config-load time, i.e.
// each startVite() call below) to whichever port actually ends up bound.
const DAEMON_PORT = await listenHermetic(app);

const servers = [];
const startVite = async (extraProxy) => {
  const server = await vite.createServer({
    configFile: path.join(webDir, "vite.config.ts"), root: webDir, logLevel: "silent",
    server: { port: 0, strictPort: false, host: "127.0.0.1", ...(extraProxy ? { proxy: extraProxy } : {}) },
  });
  await server.listen();
  servers.push(server);
  const addr = server.httpServer.address();
  return `http://127.0.0.1:${addr.port}`;
};

try {
  const direct = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/version`);
  check("(0) CONTROL: the daemon's real loopback port answers a plain request 200", direct.status === 200);
  const directFwd = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/version`, { headers: { "x-forwarded-for": "198.51.100.7" } });
  const directFwdBody = await directFwd.json();
  check("(0) CONTROL: the same port refuses a request that carries X-Forwarded-For (403, code proxy-shaped-header) with NO proxy mode configured", directFwd.status === 403 && directFwdBody.code === "proxy-shaped-header");

  const plainOrigin = await startVite(null);
  const viaDev = await fetch(`${plainOrigin}/api/version`);
  check(`(A) the repo's real vite dev proxy (no xfwd) reaches the daemon with loopback trust: GET /api/version through it is 200 (got ${viaDev.status})`, viaDev.status === 200);

  const xfwdOrigin = await startVite({ "/api": { target: `http://127.0.0.1:${DAEMON_PORT}`, changeOrigin: true, xfwd: true } });
  const viaXfwd = await fetch(`${xfwdOrigin}/api/version`);
  const xfwdBody = await viaXfwd.json().catch(() => ({}));
  check(`(B) CONTROL: the same dev proxy with xfwd:true is refused 403 code 'proxy-shaped-header' (got ${viaXfwd.status} ${xfwdBody.code}) — so (A)'s 200 is not vacuous`, viaXfwd.status === 403 && xfwdBody.code === "proxy-shaped-header");
} finally {
  for (const s of servers) await s.close();
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the repo's vite dev proxy (no xfwd) keeps loopback trust after the unconditional downgrade, and the xfwd:true control is refused"
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
