import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e7d6e43b, Code Review Minor: the boot pre-warm for any "npm-pinned" capability row granted on
// some profile (capabilities/prewarm.ts), mirroring python/prewarm.ts's prewarmMarkitdownForProfilesAtBoot
// shape. Hermetic: a FAKE db-shaped object (listCapabilityDefs/listAllAgents — capability grants live on the AGENT row since card afe1bc90), no real daemon/DB — and the
// npm-pinned provisioner is injected so the "kick" this triggers never touches the network/filesystem for
// real.
//
// Proves:
//   (a) no npm-pinned row at all ⇒ no-op, returns [].
//   (b) an npm-pinned row exists but NO profile grants its slug ⇒ no-op, returns [].
//   (c) an npm-pinned row exists AND a profile grants its slug ⇒ it is kicked (resolveCapabilityServer is
//       actually called — proven via the injected provisioner firing) and its slug is returned.
//   (d) a profile granting a DIFFERENT slug (or a non-npm-pinned-kind row) never triggers a kick for an
//       unrelated npm-pinned row.
//   (e) multiple npm-pinned rows, multiple grants ⇒ every granted one is kicked, independently.
//
// Run: 1) build, 2) node test/npm-pinned-prewarm.mjs
import fs from "node:fs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("npm-pinned-prewarm-");
delete process.env.LOOM_NPM_PINNED_NO_PROVISION;

const { prewarmNpmPinnedForProfilesAtBoot } = await import("../dist/capabilities/prewarm.js");
const { __setNpmPinnedProvisionerForTest, getCapabilityProvisionStatus } = await import("../dist/capabilities/registry.js");

const flush = () => new Promise((r) => setTimeout(r, 10));

function npmPinnedRow(slug, pkg = "pkg-" + slug, version = "1.0.0") {
  return {
    id: `cap-${slug}`, slug, name: "x", description: "d", transport: "stdio", kind: "npm-pinned",
    provisionJson: JSON.stringify({ kind: "npm-pinned", package: pkg, version, binRelativeToPackageJson: "bin/cli.js" }),
    toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null, createdAt: new Date().toISOString(),
  };
}
function bundledRow(slug) {
  return {
    id: `cap-${slug}`, slug, name: "x", description: "d", transport: "stdio", kind: "bundled",
    provisionJson: JSON.stringify({ kind: "bundled", command: "npx", args: [] }),
    toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null, createdAt: new Date().toISOString(),
  };
}

// ===================== (a) no npm-pinned row at all =====================
{
  const db = { listCapabilityDefs: () => [bundledRow("image-gen-bundled")], listAllAgents: () => [{ capabilities: [{ slug: "image-gen-bundled" }] }] };
  check("(a) no npm-pinned row ⇒ no-op, returns []", JSON.stringify(prewarmNpmPinnedForProfilesAtBoot(db)) === "[]");
}

// ===================== (b) npm-pinned row exists, nothing grants it =====================
{
  const db = { listCapabilityDefs: () => [npmPinnedRow("ungranted-slug")], listAllAgents: () => [{ capabilities: [] }, { capabilities: [{ slug: "something-else" }] }] };
  check("(b) npm-pinned row exists but ungranted ⇒ no-op, returns []", JSON.stringify(prewarmNpmPinnedForProfilesAtBoot(db)) === "[]");
}

// ===================== (c) granted ⇒ kicked =====================
{
  let kicked = false;
  __setNpmPinnedProvisionerForTest(async () => { kicked = true; return { binary: null, outcome: "install-failed" }; });
  const db = { listCapabilityDefs: () => [npmPinnedRow("granted-slug")], listAllAgents: () => [{ capabilities: [{ slug: "granted-slug" }] }] };
  const result = prewarmNpmPinnedForProfilesAtBoot(db);
  check("(c) a granted npm-pinned row's slug is returned", JSON.stringify(result) === JSON.stringify(["granted-slug"]));
  await flush();
  check("(c) the provisioner was actually kicked (resolveCapabilityServer really ran)", kicked);
  check("(c) status reflects the kick (installing then failed)", getCapabilityProvisionStatus("granted-slug")?.state === "failed");
}

// ===================== (d) a grant for a DIFFERENT slug never kicks an unrelated row =====================
{
  let kicked = false;
  __setNpmPinnedProvisionerForTest(async () => { kicked = true; return { binary: null, outcome: "install-failed" }; });
  const db = { listCapabilityDefs: () => [npmPinnedRow("isolated-slug")], listAllAgents: () => [{ capabilities: [{ slug: "totally-different-slug" }] }] };
  const result = prewarmNpmPinnedForProfilesAtBoot(db);
  check("(d) an unrelated grant never kicks this npm-pinned row", result.length === 0 && !kicked);
}

// ===================== (e) multiple rows, multiple grants — each kicked independently =====================
{
  const kickedSlugs = [];
  __setNpmPinnedProvisionerForTest(async (opts) => { kickedSlugs.push(opts.package); return { binary: null, outcome: "install-failed" }; });
  const db = {
    listCapabilityDefs: () => [npmPinnedRow("multi-a", "pkg-multi-a"), npmPinnedRow("multi-b", "pkg-multi-b"), npmPinnedRow("multi-ungranted", "pkg-multi-ungranted")],
    listAllAgents: () => [{ capabilities: [{ slug: "multi-a" }] }, { capabilities: [{ slug: "multi-b" }] }],
  };
  const result = prewarmNpmPinnedForProfilesAtBoot(db);
  check("(e) both granted rows are returned, the ungranted one is not", JSON.stringify(result.sort()) === JSON.stringify(["multi-a", "multi-b"]));
  await flush();
  check("(e) both granted rows were actually kicked", kickedSlugs.includes("pkg-multi-a") && kickedSlugs.includes("pkg-multi-b"));
  check("(e) the ungranted row was never kicked", !kickedSlugs.includes("pkg-multi-ungranted"));
}

try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort — the harness registry also sweeps this */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — prewarmNpmPinnedForProfilesAtBoot kicks exactly the npm-pinned capability_defs rows at least one profile grants, independently per slug, and is a correct no-op when there's no npm-pinned row or no grant for it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
