import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7c1d6dbf — the human-only `sharedVaultRoots` platform list: the one shared predicate, the validator
// trust boundary, the one-shot seed migration. (The auto-committer's use of it is vault-commit-code-repo-guard.mjs.)
//   (1) isSharedVaultRoot: equality only (not subfolder, not parent), trailing slash, junction, fail-closed on empty/relative.
//   (2) validators: platform validators accept an absolute list, reject relative/blank/oversize; `null` clears (PATCH);
//       NEGATIVE CONTROL — the AGENT project-config validator and the elevated Lead's project validator REJECT the key.
//   (3) no agent write path: no source under src/ calls setPlatformConfig( except the human REST PATCH and the seed;
//       `sharedVaultRoots` appears in no agent-facing MCP file other than mcp/platform.ts's platform schemas.
//   (4) seed migration against a COPY of a pre-migration DB snapshot (made by the pre-change schema, closed, file-copied):
//       seeds exactly once, records history, second boot no-ops; ambiguous/none seeds nothing and does NOT stamp;
//       an owner-edited list is never overwritten; a root that also hosts a non-vault-only project's code is no candidate.
// Run after build: node test/shared-vault-roots.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { stripComments } from "./_strip-comments.mjs";

useOwnLoomHome("loom-svr-home-");
const { Db } = await import("../dist/db.js");
const { isSharedVaultRoot } = await import("../dist/vault/shared-roots.js");
const { seedSharedVaultRootsOnce, SHARED_VAULT_ROOTS_SEED_KEY } = await import("../dist/vault/shared-roots-seed.js");
const {
  validatePlatformConfigOverride, validatePlatformConfigPatch, validateAgentProjectConfigOverride, validateProjectConfigOverride,
} = await import("../dist/mcp/platform.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const root = fs.realpathSync(mkdtempManaged("loom-svr-"));
const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const initRepo = (dir) => { fs.mkdirSync(dir, { recursive: true }); git(dir, "init"); };

// ===================== (1) predicate =====================
{
  const repo = path.join(root, "p1-repo");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  check("(1) exact root matches", isSharedVaultRoot(repo, [repo]));
  check("(1) trailing slash on the entry matches", isSharedVaultRoot(repo, [repo + path.sep]));
  check("(1) a listed SUBFOLDER does not vouch for its parent", !isSharedVaultRoot(repo, [path.join(repo, "sub")]));
  check("(1) a listed PARENT does not vouch for a child", !isSharedVaultRoot(path.join(repo, "sub"), [repo]));
  check("(1) empty / undefined list fails closed", !isSharedVaultRoot(repo, []) && !isSharedVaultRoot(repo, undefined));
  check("(1) relative and blank entries never match", !isSharedVaultRoot(repo, ["p1-repo", "", "  "]));
  const link = path.join(root, "p1-link");
  fs.symlinkSync(repo, link, "junction");
  check("(1) a junction to the root matches (realpath both sides)", isSharedVaultRoot(repo, [link]) && isSharedVaultRoot(link, [repo]));
  if (process.platform === "win32") check("(1) case variant matches on win32", isSharedVaultRoot(repo, [repo.toUpperCase()]));
}

// ===================== (2) validators =====================
{
  const abs = path.join(root, "v-abs");
  check("(2) platform override accepts an absolute list", validatePlatformConfigOverride({ sharedVaultRoots: [abs] }).ok === true);
  check("(2) ...rejects a relative entry", validatePlatformConfigOverride({ sharedVaultRoots: ["rel/path"] }).ok === false);
  check("(2) ...rejects a blank entry", validatePlatformConfigOverride({ sharedVaultRoots: [""] }).ok === false);
  check("(2) ...rejects an oversize list", validatePlatformConfigOverride({ sharedVaultRoots: Array.from({ length: 65 }, (_, i) => path.join(root, `r${i}`)) }).ok === false);
  check("(2) PATCH accepts a list and null (clear)", validatePlatformConfigPatch({ sharedVaultRoots: [abs] }).ok === true && validatePlatformConfigPatch({ sharedVaultRoots: null }).ok === true);
  check("(2) the persisted shape rejects null (a null can never reach setPlatformConfig)", validatePlatformConfigOverride({ sharedVaultRoots: null }).ok === false);
  // NEGATIVE CONTROL: an agent-shaped write of the key is rejected on every agent-reachable config validator.
  const agent = validateAgentProjectConfigOverride({ sharedVaultRoots: [abs] });
  check("(2) NEGATIVE CONTROL: the AGENT project-config validator REJECTS sharedVaultRoots", agent.ok === false);
  const lead = validateProjectConfigOverride({ sharedVaultRoots: [abs] });
  check("(2) NEGATIVE CONTROL: the elevated Lead's (full) project-config validator REJECTS sharedVaultRoots", lead.ok === false);
  // Positive control for the negative controls above: the SAME validators accept an ordinary key.
  check("(2) (positive control) the same validators accept an ordinary key", validateAgentProjectConfigOverride({}).ok === true && validateProjectConfigOverride({}).ok === true);
}

// ===================== (3) no agent write path (source scan) =====================
{
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
  const files = walk(srcDir).map((f) => ({ f: path.relative(srcDir, f).replace(/\\/g, "/"), s: stripComments(fs.readFileSync(f, "utf8")) }));
  const writers = files.filter((x) => x.s.includes("setPlatformConfig(")).map((x) => x.f).sort();
  check(`(3) setPlatformConfig( is called only by db.ts (definition), the human REST PATCH and the seed — saw: ${writers.join(", ")}`,
    JSON.stringify(writers) === JSON.stringify(["db.ts", "gateway/server.ts", "vault/shared-roots-seed.ts"]));
  const mentions = files.filter((x) => x.f.startsWith("mcp/") && x.s.includes("sharedVaultRoots")).map((x) => x.f).sort();
  check(`(3) among agent-facing MCP routers only mcp/platform.ts (the platform schemas) names sharedVaultRoots — saw: ${mentions.join(", ")}`,
    JSON.stringify(mentions) === JSON.stringify(["mcp/platform.ts"]));
  // Positive control for the scan: it does see an ordinary platform key.
  check("(3) (positive control) the scan finds an ordinary platform key in mcp/platform.ts", files.some((x) => x.f === "mcp/platform.ts" && x.s.includes("mutedBrowserNotifications")));
}

// ===================== (4) seed migration against a COPY of a pre-migration snapshot =====================
const now = new Date().toISOString();
const proj = (id, o) => ({ id, name: id, repoPath: "", vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: false, ...o });
function makeSnapshot(name, build) {
  // "Pre-migration snapshot": a DB produced by the existing schema, closed, then FILE-COPIED; the seed only ever
  // runs against the copy (never the original file) — so it also proves it works on a reopened, not just a hot, DB.
  const src = path.join(root, `${name}-src.db`);
  const db0 = new Db(src);
  build(db0);
  db0.close();
  const copy = path.join(root, `${name}-copy.db`);
  fs.copyFileSync(src, copy);
  return copy;
}
{
  const shared = path.join(root, "notes-vault");
  initRepo(shared);
  const codeA = path.join(root, "codeA"); initRepo(codeA);
  const codeB = path.join(root, "codeB"); initRepo(codeB);
  const vA = path.join(shared, "Projects", "A"); fs.mkdirSync(vA, { recursive: true });
  const vB = path.join(shared, "Projects", "B"); fs.mkdirSync(vB, { recursive: true });
  const copy = makeSnapshot("seed-ok", (db) => {
    db.insertProject(proj("a", { repoPath: codeA, vaultPath: vA }));
    db.insertProject(proj("b", { repoPath: codeB, vaultPath: vB }));
    db.insertProject(proj("notes", { repoPath: shared, vaultPath: shared, vaultOnly: true })); // pure notes project bound to the vault
  });
  const db = new Db(copy);
  check("(4) the copy starts with NO sharedVaultRoots and no marker", db.getPlatformConfig().sharedVaultRoots === undefined && !db.getMeta(SHARED_VAULT_ROOTS_SEED_KEY));
  const r1 = seedSharedVaultRootsOnce(db);
  check("(4) seeds exactly the one qualifying root (>=2 distinct vaults, no non-vaultOnly code)", r1.outcome === "seeded" && path.resolve(r1.root).toLowerCase() === path.resolve(shared).toLowerCase() && r1.vouchers >= 2);
  check("(4) ...persisted in the platform override", db.getPlatformConfig().sharedVaultRoots?.length === 1);
  check("(4) ...recorded in the platform-config change history by the migration actor", JSON.stringify(db.listPlatformConfigHistory()).includes("migration:7c1d6dbf"));
  check("(4) ...and the one-shot marker is stamped", !!db.getMeta(SHARED_VAULT_ROOTS_SEED_KEY));
  // Idempotence + owner edit: owner clears the list, a later boot must NOT re-seed.
  db.setPlatformConfig({});
  const r2 = seedSharedVaultRootsOnce(db);
  check("(4) a second boot is a no-op (marker) and does not re-seed an owner-cleared list", r2.outcome === "already-done" && db.getPlatformConfig().sharedVaultRoots === undefined);
  db.close();
  // Reopen the SAME copied file: marker survived.
  const db2 = new Db(copy);
  check("(4) the marker survives a reopen of the copy", seedSharedVaultRootsOnce(db2).outcome === "already-done");
  db2.close();
}
{
  // Owner-edited list present BEFORE the first seed: never overwritten, marker stamped.
  const shared = path.join(root, "notes-vault-2"); initRepo(shared);
  const c1 = path.join(root, "c-own-1"); initRepo(c1);
  const c2 = path.join(root, "c-own-2"); initRepo(c2);
  const v1 = path.join(shared, "P1"); fs.mkdirSync(v1, { recursive: true });
  const v2 = path.join(shared, "P2"); fs.mkdirSync(v2, { recursive: true });
  const ownerPath = path.join(root, "owner-chosen");
  const copy = makeSnapshot("seed-owner", (db) => {
    db.insertProject(proj("x", { repoPath: c1, vaultPath: v1 }));
    db.insertProject(proj("y", { repoPath: c2, vaultPath: v2 }));
    db.setPlatformConfig({ sharedVaultRoots: [ownerPath] });
  });
  const db = new Db(copy);
  const r = seedSharedVaultRootsOnce(db);
  check("(4) a non-empty owner-edited list is never overwritten", r.outcome === "owner-list-present" && JSON.stringify(db.getPlatformConfig().sharedVaultRoots) === JSON.stringify([ownerPath]));
  db.close();
}
{
  // None: a single project's vault (only 1 voucher) is not a candidate; nothing stamped so a later boot retries.
  const shared = path.join(root, "solo-vault"); initRepo(shared);
  const c1 = path.join(root, "c-solo"); initRepo(c1);
  const v1 = path.join(shared, "P1"); fs.mkdirSync(v1, { recursive: true });
  const copy = makeSnapshot("seed-none", (db) => db.insertProject(proj("solo", { repoPath: c1, vaultPath: v1 })));
  const db = new Db(copy);
  const r = seedSharedVaultRootsOnce(db);
  check("(4) fewer than 2 distinct vaults ⇒ no candidate: seeds nothing but the decision is FINAL (marker stamped)", r.outcome === "none" && db.getPlatformConfig().sharedVaultRoots === undefined && !!db.getMeta(SHARED_VAULT_ROOTS_SEED_KEY));
  // TRUE ONE-SHOT: a SECOND vault later appearing inside that repo (the layout-inference re-arm path) must NOT seed.
  const c2 = path.join(root, "c-solo-2"); initRepo(c2);
  const v2 = path.join(shared, "P2"); fs.mkdirSync(v2, { recursive: true });
  db.insertProject(proj("solo2", { repoPath: c2, vaultPath: v2 }));
  check("(4) ...a later boot that now WOULD qualify does NOT seed (layout inference is never re-armed)", seedSharedVaultRootsOnce(db).outcome === "already-done" && db.getPlatformConfig().sharedVaultRoots === undefined);
  db.close();
}
{
  // NEGATIVE CONTROL: a root used as CODE — a non-vaultOnly project whose repo IS the root but whose vault lies
  // OUTSIDE it — disqualifies the root, even with >=2 distinct vault paths under it.
  const codeRepo = path.join(root, "code-and-notes"); initRepo(codeRepo);
  const d1 = path.join(root, "d1"); initRepo(d1);
  const d2 = path.join(root, "d2"); initRepo(d2);
  const v1 = path.join(codeRepo, "q1"); fs.mkdirSync(v1, { recursive: true });
  const v2 = path.join(codeRepo, "q2"); fs.mkdirSync(v2, { recursive: true });
  const outsideVault = path.join(root, "vault-outside-root"); fs.mkdirSync(outsideVault, { recursive: true });
  const copy = makeSnapshot("seed-code", (db) => {
    db.insertProject(proj("uses-root-as-code", { repoPath: codeRepo, vaultPath: outsideVault }));
    db.insertProject(proj("uses-root-no-vault", { repoPath: codeRepo, vaultPath: "" }));
    db.insertProject(proj("q1", { repoPath: d1, vaultPath: v1 }));
    db.insertProject(proj("q2", { repoPath: d2, vaultPath: v2 }));
  });
  const db = new Db(copy);
  const r = seedSharedVaultRootsOnce(db);
  check("(4) NEGATIVE CONTROL: a project with repo = root and its vault OUTSIDE (or empty) disqualifies the root", r.outcome === "none" && db.getPlatformConfig().sharedVaultRoots === undefined);
  db.close();
}
{
  // The realistic shape (generic, fictional names): several NOTES-REPO projects (repo = the shared root, vault
  // inside it, non-vaultOnly), ordinary code projects with vaults nested in that root, and a RESERVED git home
  // whose two vaultOnly projects share ONE vault path. Exactly the notes root must seed.
  const notes = path.join(root, "shape-notes-root"); initRepo(notes);
  const home = path.join(root, "shape-reserved-home"); initRepo(home);
  const mkv = (base, n) => { const v = path.join(base, n); fs.mkdirSync(v, { recursive: true }); return v; };
  const copy = makeSnapshot("seed-shape", (db) => {
    for (const n of ["Research1", "Research2", "Research3"]) db.insertProject(proj(`nr-${n}`, { repoPath: notes, vaultPath: mkv(notes, n) })); // notes-repo projects
    for (const n of ["A", "B"]) { const c = path.join(root, `shape-code-${n}`); initRepo(c); db.insertProject(proj(`code-${n}`, { repoPath: c, vaultPath: mkv(path.join(notes, "Projects"), n) })); }
    // Reserved home that is ALSO a git repo: two vaultOnly rows (one archived, one live, + an older live duplicate) share one vault path.
    const hv = mkv(home, "vault");
    db.insertProject(proj("home-live", { repoPath: hv, vaultPath: hv, vaultOnly: true, reserved: true }));
    db.insertProject(proj("home-live-old", { repoPath: hv, vaultPath: hv, vaultOnly: true, reserved: true }));
    db.insertProject(proj("home-archived", { repoPath: hv, vaultPath: hv, vaultOnly: true, reserved: true, archivedAt: now }));
    // Another vaultOnly repo with a single vault path (1 distinct path, never a candidate).
    const solo = path.join(root, "shape-solo-vaultonly"); initRepo(solo);
    db.insertProject(proj("solo-vo", { repoPath: solo, vaultPath: solo, vaultOnly: true }));
  });
  const db = new Db(copy);
  const r = seedSharedVaultRootsOnce(db);
  check("(4) real-layout shapes: exactly the notes root seeds (notes-repo projects do not disqualify; reserved home and single-path vaultOnly repo are not candidates)",
    r.outcome === "seeded" && path.resolve(r.root).toLowerCase() === path.resolve(notes).toLowerCase() && r.vouchers === 5);
  check("(4) ...and the reserved home root was NOT added", JSON.stringify(db.getPlatformConfig().sharedVaultRoots).toLowerCase().includes("reserved-home") === false);
  // Mutation-sensitivity of the reserved exclusion: without it the two reserved rows would be one distinct path (<2) anyway,
  // so also prove DISTINCT-path counting directly: a root with 2 projects sharing ONE vault path is not a candidate.
  const two = path.join(root, "shape-two-same-path"); initRepo(two);
  const sv = mkv(two, "shared-one");
  const copy2 = makeSnapshot("seed-samepath", (d) => { for (const id of ["s1", "s2"]) d.insertProject(proj(id, { repoPath: path.join(root, `sp-${id}`), vaultPath: sv })); });
  const db2 = new Db(copy2);
  check("(4) DISTINCT vault paths are counted, not projects: two projects sharing one vault path are no candidate", seedSharedVaultRootsOnce(db2).outcome === "none");
  db.close(); db2.close();
}
{
  // Ambiguous: two qualifying roots ⇒ seed nothing, stamp nothing.
  const mk = (n) => { const s = path.join(root, `amb-${n}`); initRepo(s); const out = []; for (const k of [1, 2]) { const c = path.join(root, `amb-code-${n}-${k}`); initRepo(c); const v = path.join(s, `P${k}`); fs.mkdirSync(v, { recursive: true }); out.push({ c, v }); } return out; };
  const a = mk("a"), b = mk("b");
  const copy = makeSnapshot("seed-amb", (db) => {
    [...a, ...b].forEach((x, i) => db.insertProject(proj(`amb${i}`, { repoPath: x.c, vaultPath: x.v })));
  });
  const db = new Db(copy);
  const r = seedSharedVaultRootsOnce(db);
  check("(4) two qualifying roots ⇒ ambiguous: nothing seeded, marker stamped (one-shot)", r.outcome === "ambiguous" && r.candidates.length === 2 && db.getPlatformConfig().sharedVaultRoots === undefined && !!db.getMeta(SHARED_VAULT_ROOTS_SEED_KEY));
  check("(4) ...and the next boot is a no-op", seedSharedVaultRootsOnce(db).outcome === "already-done");
  db.close();
}
{
  // ARCHIVED code disqualifies: an archived non-vaultOnly {repo = root, vault elsewhere} counts (fail-closed).
  const rootA = path.join(root, "arch-root"); initRepo(rootA);
  const mk = (n) => { const c = path.join(root, `arch-code-${n}`); initRepo(c); const v = path.join(rootA, `P${n}`); fs.mkdirSync(v, { recursive: true }); return { c, v }; };
  const p1 = mk(1), p2 = mk(2);
  const elsewhere = path.join(root, "arch-vault-elsewhere"); fs.mkdirSync(elsewhere, { recursive: true });
  const copy = makeSnapshot("seed-archived", (db) => {
    db.insertProject(proj("arch-1", { repoPath: p1.c, vaultPath: p1.v }));
    db.insertProject(proj("arch-2", { repoPath: p2.c, vaultPath: p2.v }));
    db.insertProject(proj("arch-code", { repoPath: rootA, vaultPath: elsewhere, archivedAt: now }));
  });
  const db = new Db(copy);
  const r = seedSharedVaultRootsOnce(db);
  check("(4) an ARCHIVED project using the root as code disqualifies it (nothing seeded)", r.outcome === "none" && db.getPlatformConfig().sharedVaultRoots === undefined);
  db.close();
}
{
  // CORRUPT config row: skip, never write over it, do NOT stamp (so it retries once fixed).
  const shared = path.join(root, "corrupt-notes"); initRepo(shared);
  const mkp = (n) => { const c = path.join(root, `corrupt-code-${n}`); initRepo(c); const v = path.join(shared, `P${n}`); fs.mkdirSync(v, { recursive: true }); return { c, v }; };
  const a = mkp(1), b = mkp(2);
  const copy = makeSnapshot("seed-corrupt", (db) => {
    db.insertProject(proj("cc1", { repoPath: a.c, vaultPath: a.v }));
    db.insertProject(proj("cc2", { repoPath: b.c, vaultPath: b.v }));
    db.setPlatformConfig({ watchers: { wakeMs: 90000 } }); // makes the row exist; corrupted below
  });
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(copy);
  raw.prepare("UPDATE platform_config SET override_json = ? WHERE id = 1").run("{not json");
  raw.close();
  const db = new Db(copy);
  const r = seedSharedVaultRootsOnce(db);
  const rawAfter = new Database(copy, { readonly: true }).prepare("SELECT override_json FROM platform_config WHERE id = 1").get().override_json;
  check("(4) a CORRUPT platform_config row: seed skipped, outcome config-corrupt", r.outcome === "config-corrupt");
  check("(4) ...the corrupt blob is NOT written over, and the marker is NOT stamped", rawAfter === "{not json" && !db.getMeta(SHARED_VAULT_ROOTS_SEED_KEY));
  // Human fixes the config ⇒ the next boot retries and seeds.
  db.setPlatformConfig({});
  check("(4) ...once the config is fixed, the next boot retries and seeds", seedSharedVaultRootsOnce(db).outcome === "seeded");
  db.close();
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
await finishAndExit(failures === 0 ? 0 : 1);
