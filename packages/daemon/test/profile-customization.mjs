import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic guard for bundled-PROFILE customization — the profiles analog of skills-customization, but
// FIELD-level (profiles are structured DB rows, not text). Covers the daemon + shared foundation:
//   • base_snapshot column + migration + seedProfileBaseSnapshots boot backfill (seed-if-absent, safe dir).
//   • bundledProfileByName helper (matched BY NAME; distinct from isBundledProfile's role gate).
//   • mergeProfile field-level 3-way: clean fast-forward, non-overlapping clean, all-three-differ conflict;
//     array atomicity (allowDelta/skills sorted-copy; null != []).
//   • the precise state matrix (customized / updateAvailable) from mine vs base vs shipped.
//   • adopt advances base + preserves edits (clean + per-field resolution); reset advances base; non-bundled
//     carries no state; null-base falls back to shipped.
// PART B — REST via the REAL buildServer driven by app.inject (network-free): list/get computed state,
//   update-diff, merge-preview (409 no update / 404 not bundled), adopt (clean / unresolved 409 / resolved),
//   reset advances base, PUT round-trip tolerates the computed fields.
//
// Fully hermetic — fresh LOOM_HOME, in-process Db + buildServer, no daemon / no claude / no network.
// Run after build: node test/profile-customization.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-prof-cust-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45419";
delete process.env.LOOM_DEV;

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { bundledProfileByName, resetProfileToBundled, seedProfileBaseSnapshots } = await import("../dist/profiles/seed.js");
const {
  mergeProfile, profileCustomizationState, profileUpdateAvailable, previewProfileMerge,
  profileUpdateDiff, adoptProfileUpdate,
} = await import("../dist/profiles/customization.js");

// A full bundled-shaped profile def (sans id) — the building block for mine/base/shipped.
const prof = (over = {}) => ({
  name: "Rig", role: "worker", description: "blurb", allowDelta: [], skills: null, model: null, icon: null,
  browserTesting: false, documentConversion: false, ...over,
});
const db = new Db();

try {
  // ===================================================================================================
  // PART A — engine + store level
  // ===================================================================================================

  // --- bundledProfileByName: matched BY NAME (a real shipped name resolves; a made-up one doesn't) ----
  check("bundledProfileByName('Dev') resolves a shipped def", bundledProfileByName("Dev")?.role === "worker");
  check("bundledProfileByName('Nope Made Up') → undefined", bundledProfileByName("Nope Made Up") === undefined);

  // --- mergeProfile field-level 3-way ----------------------------------------------------------------
  // (1) clean fast-forward: mine == base, shipped changed a field → take shipped, clean.
  const base1 = prof({ description: "old", model: null });
  const ff = mergeProfile(base1, prof({ description: "old", model: null }), prof({ description: "old", model: "claude-opus-4-8" }));
  check("[merge] mine==base fast-forward is clean", ff.clean === true && ff.conflicts.length === 0);
  check("[merge] fast-forward takes the shipped field", ff.merged.model === "claude-opus-4-8");
  // (2) non-overlapping clean: mine edits description, shipped edits model → both kept, clean.
  const clean = mergeProfile(prof(), prof({ description: "MINE" }), prof({ model: "m2" }));
  check("[merge] non-overlapping edits merge clean", clean.clean === true && clean.conflicts.length === 0);
  check("[merge] clean keeps mine's edit AND takes the shipped change", clean.merged.description === "MINE" && clean.merged.model === "m2");
  // (3) all-three-differ conflict: mine and shipped both change description differently from base.
  const conf = mergeProfile(prof({ description: "base" }), prof({ description: "MINE" }), prof({ description: "SHIPPED" }));
  check("[merge] all-three-differ → conflict (clean:false)", conf.clean === false && conf.conflicts.length === 1);
  check("[merge] conflict carries field + mine/base/shipped",
    conf.conflicts[0].field === "description" && conf.conflicts[0].mine === "MINE" &&
    conf.conflicts[0].base === "base" && conf.conflicts[0].shipped === "SHIPPED");
  check("[merge] conflict field left at mine in merged (pending resolution)", conf.merged.description === "MINE");
  // (4) convergent: mine == shipped (both differ from base) → no conflict.
  const conv = mergeProfile(prof({ icon: "a" }), prof({ icon: "z" }), prof({ icon: "z" }));
  check("[merge] convergent mine==shipped is clean (no conflict)", conv.clean === true && conv.merged.icon === "z");

  // --- array atomicity: sorted-copy equality; null (all) distinct from [] -----------------------------
  // allowDelta reordered only → user didn't change it semantically → take shipped (clean, no conflict).
  const arrFF = mergeProfile(prof({ allowDelta: ["a", "b"] }), prof({ allowDelta: ["b", "a"] }), prof({ allowDelta: ["a", "b", "c"] }));
  check("[merge][array] reorder counts as equal (mine==base) → take shipped", arrFF.clean === true && JSON.stringify(arrFF.merged.allowDelta) === JSON.stringify(["a", "b", "c"]));
  // skills null (all) vs [] (none) are DISTINCT: mine null==base null, shipped [] → take shipped.
  const skFF = mergeProfile(prof({ skills: null }), prof({ skills: null }), prof({ skills: [] }));
  check("[merge][array] skills null==null, shipped [] differs → take shipped []", skFF.clean === true && Array.isArray(skFF.merged.skills) && skFF.merged.skills.length === 0);
  // mine [] vs base null → mine edited (null != []) → keep mine when shipped==base(null).
  const skEdit = mergeProfile(prof({ skills: null }), prof({ skills: [] }), prof({ skills: null }));
  check("[merge][array] skills [] != null counts as a user edit → keep mine []", skEdit.clean === true && Array.isArray(skEdit.merged.skills) && skEdit.merged.skills.length === 0);

  // --- seedProfileBaseSnapshots: backfill = shipped, seed-if-absent -----------------------------------
  db.insertProfile({ id: "pDev", ...prof({ name: "Dev" }) }); // bundled-by-name, pristine (== shipped)
  db.insertProfile({ id: "pCustom", ...prof({ name: "My Custom Rig" }) }); // user-created
  check("no base snapshot before backfill", db.getProfileBaseSnapshot("pDev") === null);
  const seeded = seedProfileBaseSnapshots(db);
  check("[seed] backfilled the bundled-by-name row", seeded.includes("Dev"));
  check("[seed] did NOT backfill the user-created row", !seeded.includes("My Custom Rig") && db.getProfileBaseSnapshot("pCustom") === null);
  check("[seed] base now set for the bundled row", db.getProfileBaseSnapshot("pDev") !== null);
  // seed-if-absent: a second pass never clobbers an existing base.
  db.setProfileBaseSnapshot("pDev", JSON.stringify(bundledProfileByName("Dev")));
  const seeded2 = seedProfileBaseSnapshots(db);
  check("[seed] second pass does NOT re-backfill an existing base", !seeded2.includes("Dev"));

  // --- null-base fallback: an unset base reads as shipped → pristine ----------------------------------
  db.insertProfile({ id: "pNullBase", ...bundledProfileByName("QA Tester") }); // mine == shipped, base null
  const nbState = profileCustomizationState(db, "pNullBase");
  check("[null-base] unset base falls back to shipped → pristine (not customized, no update)",
    nbState.bundled === true && nbState.customized === false && nbState.updateAvailable === false);

  // --- state matrix (mine vs base vs shipped) on the real shipped 'Dev' def --------------------------
  const shippedDev = bundledProfileByName("Dev");
  // pristine: mine==base==shipped
  db.updateProfile("pDev", { ...shippedDev });
  db.setProfileBaseSnapshot("pDev", JSON.stringify(shippedDev));
  let s = profileCustomizationState(db, "pDev");
  check("[matrix] pristine: customized:false, updateAvailable:false", s.customized === false && s.updateAvailable === false);
  // customized only: mine != base, base == shipped
  db.updateProfile("pDev", { description: "MY EDIT" });
  s = profileCustomizationState(db, "pDev");
  check("[matrix] customized: customized:true, updateAvailable:false", s.customized === true && s.updateAvailable === false);
  // update-available only: mine == base, base != shipped (mine AND base both behind shipped's description)
  db.updateProfile("pDev", { description: "OLD SHIPPED" });
  db.setProfileBaseSnapshot("pDev", JSON.stringify({ ...shippedDev, description: "OLD SHIPPED" }));
  s = profileCustomizationState(db, "pDev");
  check("[matrix] update-available: customized:false, updateAvailable:true", s.customized === false && s.updateAvailable === true);
  // both: mine != base AND base != shipped
  db.updateProfile("pDev", { description: "MY EDIT", icon: "🔧" });
  db.setProfileBaseSnapshot("pDev", JSON.stringify({ ...shippedDev, model: "old-model" }));
  s = profileCustomizationState(db, "pDev");
  check("[matrix] both: customized:true, updateAvailable:true", s.customized === true && s.updateAvailable === true);

  // --- non-bundled profile: bundled:false, NO state flags --------------------------------------------
  const cust = profileCustomizationState(db, "pCustom");
  check("[non-bundled] bundled:false and no customized/updateAvailable", cust.bundled === false && cust.customized === undefined && cust.updateAvailable === undefined);

  // --- adopt (engine): clean fast-forward advances base + keeps the edit ------------------------------
  // mine edits icon (not in base/shipped); shipped changed description; base behind on description → clean
  // non-overlapping update: description fast-forwards (mine==base) while the icon edit is kept.
  const bugfix = bundledProfileByName("Bugfix");
  db.insertProfile({ id: "pAdopt", ...bugfix, description: "OLD BUGFIX DESC", icon: "🐞 MINE" }); // mine
  db.setProfileBaseSnapshot("pAdopt", JSON.stringify({ ...bugfix, description: "OLD BUGFIX DESC" })); // base: old desc, no icon edit
  check("[adopt] precondition: update available", profileUpdateAvailable(db, "pAdopt") === true);
  const pv = previewProfileMerge(db, "pAdopt");
  check("[adopt] preview clean for a non-overlapping update", pv.clean === true);
  const ad = adoptProfileUpdate(db, "pAdopt", {});
  check("[adopt] adopt ok", ad.ok === true);
  check("[adopt] base advanced (updateAvailable now false)", profileUpdateAvailable(db, "pAdopt") === false);
  check("[adopt] adopted keeps the user's icon edit AND takes the shipped description",
    db.getProfile("pAdopt").icon === "🐞 MINE" && db.getProfile("pAdopt").description === bundledProfileByName("Bugfix").description);
  check("[adopt] still customized (the edit survived)", profileCustomizationState(db, "pAdopt").customized === true);

  // --- adopt with a CONFLICT: unresolved → refused; resolution applied --------------------------------
  db.insertProfile({ id: "pConf", ...bundledProfileByName("Dev"), name: "Content Strategy", description: "MINE DESC" });
  db.setProfileBaseSnapshot("pConf", JSON.stringify({ ...bundledProfileByName("Content Strategy"), description: "BASE DESC" }));
  // shipped Content Strategy description differs from BASE DESC, and mine differs too → conflict on description.
  check("[adopt-conf] update available", profileUpdateAvailable(db, "pConf") === true);
  const pvc = previewProfileMerge(db, "pConf");
  check("[adopt-conf] preview reports the description conflict", pvc.clean === false && pvc.conflicts.some((c) => c.field === "description"));
  const refused = adoptProfileUpdate(db, "pConf", {});
  check("[adopt-conf] empty resolutions → unresolved (refused)", refused.ok === false && refused.reason === "unresolved" && refused.unresolved.includes("description"));
  const keptMine = adoptProfileUpdate(db, "pConf", { description: "mine" });
  check("[adopt-conf] resolution=mine adopts, keeps mine's value, advances base",
    keptMine.ok === true && db.getProfile("pConf").description === "MINE DESC" && profileUpdateAvailable(db, "pConf") === false);

  // --- adopt guards ----------------------------------------------------------------------------------
  check("[adopt] non-bundled → not-bundled", adoptProfileUpdate(db, "pCustom", {}).reason === "not-bundled");
  db.updateProfile("pDev", { ...shippedDev }); db.setProfileBaseSnapshot("pDev", JSON.stringify(shippedDev));
  check("[adopt] pristine (no update) → no-update", adoptProfileUpdate(db, "pDev", {}).reason === "no-update");

  // --- reset advances base ---------------------------------------------------------------------------
  db.updateProfile("pDev", { description: "EDIT", icon: "x" });
  db.setProfileBaseSnapshot("pDev", JSON.stringify({ ...shippedDev, model: "behind" })); // both customized + update
  check("[reset] precondition: customized + update", profileCustomizationState(db, "pDev").customized === true && profileCustomizationState(db, "pDev").updateAvailable === true);
  check("[reset] resetProfileToBundled returns true", resetProfileToBundled(db, "pDev") === true);
  const rs = profileCustomizationState(db, "pDev");
  check("[reset] state cleared: pristine (base advanced to shipped)", rs.customized === false && rs.updateAvailable === false);
  check("[reset] row restored to shipped fields", db.getProfile("pDev").description === shippedDev.description);
  check("[reset] reset → false for a non-bundled name", resetProfileToBundled(db, "pCustom") === false);

  // --- update-diff: base→shipped field changes -------------------------------------------------------
  db.setProfileBaseSnapshot("pDev", JSON.stringify({ ...shippedDev, description: "OLD", model: "old-m" }));
  const diff = profileUpdateDiff(db, "pDev");
  check("[update-diff] lists base→shipped changed fields", diff.changed.some((c) => c.field === "description") && diff.changed.some((c) => c.field === "model"));
  check("[update-diff] each change carries base + shipped", diff.changed.find((c) => c.field === "description").base === "OLD" && diff.changed.find((c) => c.field === "description").shipped === shippedDev.description);
  check("[update-diff] non-bundled → null", profileUpdateDiff(db, "pCustom") === null);

  // ===================================================================================================
  // PART B — REST via buildServer + app.inject
  // ===================================================================================================
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  // update-available only (mine==base, both behind shipped) so the list/get state reads customized:false.
  db.updateProfile("pDev", { description: "OLD REST DESC" });
  db.setProfileBaseSnapshot("pDev", JSON.stringify({ ...shippedDev, description: "OLD REST DESC" }));

  const list = await app.inject({ method: "GET", url: "/api/profiles" });
  const devRow = list.json().find((p) => p.id === "pDev");
  check("[rest] GET list carries computed state on a bundled row", list.statusCode === 200 && devRow.bundled === true && devRow.updateAvailable === true && devRow.customized === false);
  const customRow = list.json().find((p) => p.id === "pCustom");
  check("[rest] GET list: user-created row bundled:false, no flags", customRow.bundled === false && customRow.customized === undefined);

  const get = await app.inject({ method: "GET", url: "/api/profiles/pDev" });
  check("[rest] GET :id carries computed state", get.statusCode === 200 && get.json().updateAvailable === true);

  const ud = await app.inject({ method: "GET", url: "/api/profiles/pDev/update-diff" });
  check("[rest] GET update-diff 200 + changed lists description", ud.statusCode === 200 && ud.json().changed.some((c) => c.field === "description"));
  check("[rest] GET update-diff 404 on non-bundled", (await app.inject({ method: "GET", url: "/api/profiles/pCustom/update-diff" })).statusCode === 404);

  const mp = await app.inject({ method: "GET", url: "/api/profiles/pDev/merge-preview" });
  check("[rest] GET merge-preview 200 + clean:true", mp.statusCode === 200 && mp.json().clean === true);

  const adopt = await app.inject({ method: "POST", url: "/api/profiles/pDev/adopt", payload: {} });
  check("[rest] POST adopt (clean) 200 + takes shipped + clears update", adopt.statusCode === 200 && adopt.json().description === shippedDev.description && adopt.json().updateAvailable === false);
  check("[rest] merge-preview now 409 (no update available)", (await app.inject({ method: "GET", url: "/api/profiles/pDev/merge-preview" })).statusCode === 409);
  check("[rest] merge-preview 404 on non-bundled", (await app.inject({ method: "GET", url: "/api/profiles/pCustom/merge-preview" })).statusCode === 404);

  // conflict adopt over REST: unresolved → 409, resolved → 200.
  db.updateProfile("pConf", { description: "MINE2" });
  db.setProfileBaseSnapshot("pConf", JSON.stringify({ ...bundledProfileByName("Content Strategy"), description: "BASE2" }));
  const adoptUnres = await app.inject({ method: "POST", url: "/api/profiles/pConf/adopt", payload: {} });
  check("[rest] POST adopt with unresolved conflict → 409 + unresolved list", adoptUnres.statusCode === 409 && adoptUnres.json().unresolved.includes("description"));
  const adoptRes = await app.inject({ method: "POST", url: "/api/profiles/pConf/adopt", payload: { resolutions: { description: "shipped" } } });
  check("[rest] POST adopt resolution=shipped → 200 + takes shipped value", adoptRes.statusCode === 200 && adoptRes.json().description === bundledProfileByName("Content Strategy").description);

  // PUT round-trip tolerates the computed fields (GET → PUT the same body must not 400 on .strict()).
  const roundTrip = get.json(); // carries bundled/customized/updateAvailable
  roundTrip.description = "ROUND TRIP EDIT";
  const put = await app.inject({ method: "PUT", url: "/api/profiles/pDev", payload: roundTrip });
  check("[rest] PUT a GET body (with computed fields) → 200 (strip works)", put.statusCode === 200 && put.json().description === "ROUND TRIP EDIT");

  // reset over REST advances base → pristine.
  const reset = await app.inject({ method: "POST", url: "/api/profiles/pDev/reset", payload: {} });
  check("[rest] POST reset 200 + pristine state", reset.statusCode === 200 && reset.json().customized === false && reset.json().updateAvailable === false);

  await app.close();
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — base snapshot + migration/backfill + field-level 3-way merge + precise state + adopt/reset advance base + update-diff REST (profiles)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
