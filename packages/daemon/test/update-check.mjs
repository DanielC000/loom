import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Epic 2c-2 (UI half) — the npm "update available" check. HERMETIC + CLAUDE-FREE + NETWORK-FREE: the
// registry fetch is MOCKED (injected fetchTags), so no real network is touched. Proves:
//   (a) PACKAGED + behind → updateAvailable, latest = the mocked dist-tag, checkedAt set;
//   (b) PACKAGED + up-to-date → NOT available; beta channel reads the beta tag;
//   (c) SOURCE (packaged:false) → never fetches, always packaged:false / not-available (banner-gating);
//   (d) GET /api/update-status serves the watcher's current() (read-only);
//   (e) packaged-vs-source DETECTION both ways (resolveUmbrellaPackage on a staged tree + the LOOM_PACKAGED
//       override), and the isNewer semver-lite edges.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_VERSION = path.join(__dirname, "..", "dist", "version.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-update-check-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45332";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { UpdateCheckWatcher, isNewer, readUpdateChannel } = await import("../dist/update/check.js");
const { resolveUmbrellaPackage } = await import("../dist/version.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const setChannel = (c) => fs.writeFileSync(path.join(TMP, "update-config.json"), JSON.stringify({ channel: c }) + "\n");

// (a) PACKAGED + behind → updateAvailable, latest reflects the mocked stable ("latest") tag.
{
  setChannel("stable");
  let calls = 0;
  const w = new UpdateCheckWatcher({
    loomHome: TMP,
    installed: () => "0.2.0",
    isPackaged: () => true,
    fetchTags: async (pkg) => { calls++; check("(a) fetched the loomctl package", pkg === "loomctl"); return { latest: "0.3.0", beta: "0.4.0-beta.1" }; },
  });
  await w.tick();
  const s = w.current();
  check("(a) the registry was queried once", calls === 1);
  check("(a) packaged:true", s.packaged === true);
  check("(a) latest = stable dist-tag (0.3.0)", s.latest === "0.3.0");
  check("(a) updateAvailable when behind", s.updateAvailable === true);
  check("(a) checkedAt is set after a successful check", typeof s.checkedAt === "string" && s.checkedAt.length > 0);
  check("(a) channel reported = stable", s.channel === "stable");
}

// (b) PACKAGED + up-to-date → NOT available; switching to beta reads the beta tag.
{
  setChannel("stable");
  const w = new UpdateCheckWatcher({ loomHome: TMP, installed: () => "0.3.0", isPackaged: () => true, fetchTags: async () => ({ latest: "0.3.0", beta: "0.4.0-beta.1" }) });
  await w.tick();
  check("(b) NOT available when installed == latest", w.current().updateAvailable === false && w.current().latest === "0.3.0");

  setChannel("beta");
  const wb = new UpdateCheckWatcher({ loomHome: TMP, installed: () => "0.3.0", isPackaged: () => true, fetchTags: async () => ({ latest: "0.3.0", beta: "0.4.0-beta.1" }) });
  await wb.tick();
  check("(b) beta channel reads the beta dist-tag", wb.current().channel === "beta" && wb.current().latest === "0.4.0-beta.1");
  check("(b) beta prerelease is newer than the installed release → available", wb.current().updateAvailable === true);
}

// (c) SOURCE daemon → never fetches; always packaged:false / not-available (this is the banner gate).
{
  setChannel("stable");
  let calls = 0;
  const w = new UpdateCheckWatcher({ loomHome: TMP, installed: () => "0.2.0", isPackaged: () => false, fetchTags: async () => { calls++; return { latest: "9.9.9" }; } });
  await w.tick();
  const s = w.current();
  check("(c) source daemon NEVER hits the registry", calls === 0);
  check("(c) packaged:false", s.packaged === false);
  check("(c) updateAvailable false on source even though a newer version exists", s.updateAvailable === false);
  check("(c) latest null + checkedAt null on source", s.latest === null && s.checkedAt === null);
}

// (c2) a registry failure NEVER throws out of a tick (best-effort): keeps packaged + installed fresh.
{
  setChannel("stable");
  const w = new UpdateCheckWatcher({ loomHome: TMP, installed: () => "0.2.0", isPackaged: () => true, fetchTags: async () => { throw new Error("registry down"); } });
  let threw = false;
  try { await w.tick(); } catch { threw = true; }
  check("(c2) a fetch failure does not throw out of tick()", threw === false);
  check("(c2) status stays packaged:true / updateAvailable:false on a failed check", w.current().packaged === true && w.current().updateAvailable === false);
}

// (d) GET /api/update-status serves the watcher's current() verbatim (read-only).
{
  setChannel("stable");
  const w = new UpdateCheckWatcher({ loomHome: TMP, installed: () => "0.2.0", isPackaged: () => true, fetchTags: async () => ({ latest: "0.5.0" }) });
  await w.tick();
  const db = new Db(path.join(TMP, "loom.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub, updateStatus: () => w.current() });
  try {
    const res = await app.inject({ method: "GET", url: "/api/update-status" });
    check("(d) GET /api/update-status → 200", res.statusCode === 200);
    const body = res.json();
    check("(d) body reflects the watcher: latest 0.5.0 + updateAvailable", body.latest === "0.5.0" && body.updateAvailable === true && body.packaged === true);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }

  // ...and with NO updateStatus dep (a partial-stub server) it degrades to a safe packaged:false default.
  const db2 = new Db(path.join(TMP, "loom2.db"));
  const app2 = await buildServer({ db: db2, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  try {
    const res = await app2.inject({ method: "GET", url: "/api/update-status" });
    check("(d) missing accessor → 200 with a safe packaged:false default", res.statusCode === 200 && res.json().packaged === false && res.json().updateAvailable === false);
  } finally {
    try { await app2.close(); } catch { /* ignore */ }
    db2.close();
  }
}

// (e) isNewer semver-lite edges.
check("(e) 0.3.0 > 0.2.0", isNewer("0.3.0", "0.2.0") === true);
check("(e) 0.2.0 is NOT newer than 0.2.0", isNewer("0.2.0", "0.2.0") === false);
check("(e) 0.2.0 is NOT newer than 0.3.0", isNewer("0.2.0", "0.3.0") === false);
check("(e) a release outranks its prerelease (1.0.0 > 1.0.0-beta.1)", isNewer("1.0.0", "1.0.0-beta.1") === true);
check("(e) a prerelease is older than the release (1.0.0-beta.1 < 1.0.0)", isNewer("1.0.0-beta.1", "1.0.0") === false);
check("(e) beta.2 > beta.1", isNewer("1.0.0-beta.2", "1.0.0-beta.1") === true);
check("(e) unparseable → never newer (no false banner)", isNewer("not-a-version", "0.2.0") === false);

// (e2) channel read tolerance: missing/garbage update-config → defaults to stable.
{
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-uc-empty-"));
  check("(e2) missing update-config → stable", readUpdateChannel(emptyHome) === "stable");
  fs.writeFileSync(path.join(emptyHome, "update-config.json"), "{ not json");
  check("(e2) malformed update-config → stable", readUpdateChannel(emptyHome) === "stable");
  fs.writeFileSync(path.join(emptyHome, "update-config.json"), JSON.stringify({ channel: "beta" }));
  check("(e2) persisted beta is read back", readUpdateChannel(emptyHome) === "beta");
  for (let i = 0; i < 5; i++) { try { fs.rmSync(emptyHome, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

// (f) packaged-vs-source DETECTION both ways — resolveUmbrellaPackage on a STAGED tree (mirrors version.mjs
//     (d)). A "loomctl" root → packaged; a "loom" root → source. Run in a child against the staged dist so
//     the walk-up starts there (NOT in this repo, whose root is named "loom").
function detectName(rootPkgName, rootPkgVersion) {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `loom-detect-${rootPkgName}-`));
  fs.writeFileSync(path.join(stageRoot, "package.json"), JSON.stringify({ name: rootPkgName, version: rootPkgVersion }) + "\n");
  const stageDist = path.join(stageRoot, "dist");
  fs.mkdirSync(stageDist, { recursive: true });
  fs.copyFileSync(DIST_VERSION, path.join(stageDist, "version.js"));
  const staged = pathToFileURL(path.join(stageDist, "version.js")).href;
  const env = { ...process.env };
  delete env.LOOM_PACKAGED; // exercise the walk-up classification, not the override
  const child = spawnSync(process.execPath, [
    "--input-type=module", "-e",
    `import { isPackagedInstall, umbrellaRootDir } from ${JSON.stringify(staged)}; process.stdout.write(JSON.stringify({ packaged: isPackagedInstall(), dir: umbrellaRootDir() }));`,
  ], { env, encoding: "utf8" });
  for (let i = 0; i < 5; i++) { try { fs.rmSync(stageRoot, { recursive: true, force: true }); break; } catch { /* retry */ } }
  return { code: child.status, out: (child.stdout || "").trim(), stageRoot };
}
{
  const pkgd = detectName("loomctl", "1.2.3");
  check("(f) packaged child ran", pkgd.code === 0);
  check("(f) a `loomctl` root → isPackagedInstall() true", JSON.parse(pkgd.out || "{}").packaged === true);

  const src = detectName("loom", "1.2.3");
  check("(f) source child ran", src.code === 0);
  check("(f) a `loom` (monorepo) root → isPackagedInstall() false", JSON.parse(src.out || "{}").packaged === false);

  // also confirm the in-process resolver classifies the staged trees (sanity on resolveUmbrellaPackage)
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "loom-resolve-"));
  fs.writeFileSync(path.join(t, "package.json"), JSON.stringify({ name: "loomctl", version: "9.9.9" }));
  const sub = path.join(t, "dist", "deep"); fs.mkdirSync(sub, { recursive: true });
  const r = resolveUmbrellaPackage(sub);
  check("(f) resolveUmbrellaPackage finds the loomctl root via walk-up", r && r.name === "loomctl" && r.version === "9.9.9");
  for (let i = 0; i < 5; i++) { try { fs.rmSync(t, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

// (g) the LOOM_PACKAGED override flips detection both ways in-process.
{
  const child = spawnSync(process.execPath, [
    "--input-type=module", "-e",
    `import { isPackagedInstall } from ${JSON.stringify(pathToFileURL(DIST_VERSION).href)};
     process.env.LOOM_PACKAGED = "1"; const on = isPackagedInstall();
     process.env.LOOM_PACKAGED = "0"; const off = isPackagedInstall();
     process.stdout.write(JSON.stringify({ on, off }));`,
  ], { env: { ...process.env }, encoding: "utf8" });
  const o = JSON.parse((child.stdout || "{}").trim() || "{}");
  check("(g) LOOM_PACKAGED=1 → packaged true", o.on === true);
  check("(g) LOOM_PACKAGED=0 → packaged false", o.off === false);
}

for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — the update-check surfaces 'behind' from a MOCKED registry, gates the banner to packaged installs (source never fetches), serves read-only via /api/update-status, and detects packaged-vs-source both ways."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
