import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1)
// Card eaf2d79f — the codescape serve memory-ceiling DEFAULT is derived from host RAM, and a PATCH of
// `integrations.codescape.memoryCeilingMb` alone must not wipe `integrations.codescape.path`.
// Hermetic: Db + validators + the gateway via app.inject; no daemon boot, no claude.
//   (1) defaultCodescapeMemoryCeilingMb: 16 GB -> 4096, 64 GB -> 8192 (cap), 8 GB -> 2048 (floor), 4 GB -> floor.
//   (2) resolveCodescapeMemoryCeilingMb: no override -> derived (16 GB vs 64 GB injected); override wins
//       (even above the cap); floor 2048 stays for a tiny override; garbage RAM falls back to the cap.
//   (3) REST PATCH {integrations:{codescape:{memoryCeilingMb}}} keeps an existing `path` AND a sibling
//       integration; resolver then reads the override.
//   (4) NOT covered: the daemon's os.totalmem() wiring in index.ts, and the supervisor's own fallback closure.
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import path from "node:path";

const TMP = mkdtempManaged("loom-cs-ceil-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45318";
requireHermeticEnv();

const { defaultCodescapeMemoryCeilingMb, resolveCodescapeMemoryCeilingMb, resolveCodescapeIntegrationPath } = await import("@loom/shared");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GB = 1024 ** 3;

check("(1) 16 GB host -> 4096", defaultCodescapeMemoryCeilingMb(16 * GB) === 4096);
check("(1) 64 GB host -> 8192 (cap)", defaultCodescapeMemoryCeilingMb(64 * GB) === 8192);
check("(1) 32 GB host -> 8192 (exactly at the cap)", defaultCodescapeMemoryCeilingMb(32 * GB) === 8192);
check("(1) 8 GB host -> 2048", defaultCodescapeMemoryCeilingMb(8 * GB) === 2048);
check("(1) 4 GB host -> 2048 (floor, not 1024)", defaultCodescapeMemoryCeilingMb(4 * GB) === 2048);
check("(1) 16 GB < 64 GB (the derived default actually varies)", defaultCodescapeMemoryCeilingMb(16 * GB) < defaultCodescapeMemoryCeilingMb(64 * GB));

check("(2) no override, 16 GB -> 4096", resolveCodescapeMemoryCeilingMb(undefined, 16 * GB) === 4096);
check("(2) no override, 64 GB -> 8192", resolveCodescapeMemoryCeilingMb({}, 64 * GB) === 8192);
check("(2) override 6000 wins on a 16 GB host", resolveCodescapeMemoryCeilingMb({ integrations: { codescape: { memoryCeilingMb: 6000 } } }, 16 * GB) === 6000);
check("(2) override 12000 wins above the cap", resolveCodescapeMemoryCeilingMb({ integrations: { codescape: { memoryCeilingMb: 12000 } } }, 16 * GB) === 12000);
check("(2) override 100 floored at 2048", resolveCodescapeMemoryCeilingMb({ integrations: { codescape: { memoryCeilingMb: 100 } } }, 64 * GB) === 2048);
check("(2) non-numeric override falls back to the derived default", resolveCodescapeMemoryCeilingMb({ integrations: { codescape: { memoryCeilingMb: "x" } } }, 16 * GB) === 4096);
check("(2) garbage RAM (NaN/0) -> cap", defaultCodescapeMemoryCeilingMb(NaN) === 8192 && defaultCodescapeMemoryCeilingMb(0) === 8192);

{
  const db = new Db(path.join(TMP, "t.db"));
  db.setPlatformConfig({ integrations: { codescape: { path: "/abs/cs" } } });
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
  try {
    const r = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { integrations: { codescape: { memoryCeilingMb: 5000 } } } } });
    check("(3) PATCH {memoryCeilingMb} only -> 200", r.statusCode === 200);
    const after = db.getPlatformConfig();
    check("(3) existing codescape.path preserved", resolveCodescapeIntegrationPath(after) === "/abs/cs");
    check("(3) memoryCeilingMb persisted and read by the resolver", resolveCodescapeMemoryCeilingMb(after, 16 * GB) === 5000);

    const r2 = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { integrations: { codescape: { path: "/abs/cs2" } } } } });
    check("(3) PATCH {path} only -> 200 and keeps memoryCeilingMb", r2.statusCode === 200 &&
      resolveCodescapeMemoryCeilingMb(db.getPlatformConfig(), 16 * GB) === 5000 && resolveCodescapeIntegrationPath(db.getPlatformConfig()) === "/abs/cs2");

    const clr = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { integrations: { codescape: { memoryCeilingMb: null } } } } });
    check("(3) memoryCeilingMb:null clears it (back to the derived default) and keeps path", clr.statusCode === 200 &&
      resolveCodescapeMemoryCeilingMb(db.getPlatformConfig(), 16 * GB) === 4096 && resolveCodescapeIntegrationPath(db.getPlatformConfig()) === "/abs/cs2");

    const bad = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { integrations: { codescape: { memoryCeilingMb: -5 } } } } });
    check("(3) invalid value -> 400 and nothing clobbered", bad.statusCode === 400 &&
      resolveCodescapeIntegrationPath(db.getPlatformConfig()) === "/abs/cs2" && resolveCodescapeMemoryCeilingMb(db.getPlatformConfig(), 16 * GB) === 4096);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — derived codescape ceiling default (RAM-injected), override priority + floor, PATCH preserves path."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
