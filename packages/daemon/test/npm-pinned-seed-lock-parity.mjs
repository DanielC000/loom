import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic seed↔lock parity test (card 66ab2bc0 round 2, D2). Nothing previously tied a bundled
// "npm-pinned" seed row's `package@version` constant (SHADCN_VERSION/MCP_IMAGENATE_VERSION, seed.ts) to
// its committed lock asset — bump one constant without regenerating the matching lock and every fresh
// install of that row would go `lock-missing` on every real host, forever, with the gate staying green:
// nothing previously read a committed lock's own CONTENT against the seed row that claims to pin it.
//
// For every bundled capability row of kind "npm-pinned" (shadcn, image-gen today), asserts:
//   - a committed lock asset exists at the path the seed row's package/version resolves to;
//   - lockfileVersion is 3;
//   - the lock's root dependency entry (`packages[""].dependencies[pkg]`) equals the seeded version
//     EXACTLY — never a different version, a range, or absent;
//   - every non-root resolved entry carries a real `sha512-` integrity hash;
//   - every non-root resolved entry's `resolved` URL is under `https://registry.npmjs.org/` — never a
//     tarball/git/file spec that would sidestep the registry's own content verification.
//
// This is a CONTENT check, not a wiring check — it never spawns npm, never touches a DB, never installs
// anything; see npm-pinned-lock-asset.mjs for the npm-ci-against-a-lock MECHANISM and
// npm-pinned-provision.mjs for the provisioning STATE MACHINE.
//
// Run: 1) build, 2) node test/npm-pinned-seed-lock-parity.mjs
import fs from "node:fs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("npm-pinned-seed-lock-parity-");

const { bundledCapabilities } = await import("../dist/capabilities/seed.js");
const { npmPinnedLockAssetPath } = await import("../dist/capabilities/npm-pinned.js");

const npmPinnedRows = bundledCapabilities().filter((c) => c.kind === "npm-pinned");
check("precondition: at least two bundled rows are kind 'npm-pinned' (shadcn, image-gen)", npmPinnedRows.length >= 2);

for (const row of npmPinnedRows) {
  const provision = JSON.parse(row.provisionJson);
  const { package: pkg, version } = provision;
  const label = `${row.slug} (${pkg}@${version})`;

  const lockPath = npmPinnedLockAssetPath(pkg, version);
  const exists = fs.existsSync(lockPath);
  check(`${label}: a committed lock asset exists at ${lockPath}`, exists);
  if (!exists) continue; // nothing further to check against a lock that isn't there

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (e) {
    check(`${label}: the lock asset parses as JSON (${e instanceof Error ? e.message : String(e)})`, false);
    continue;
  }

  check(`${label}: lockfileVersion is 3`, lock.lockfileVersion === 3);
  check(`${label}: the root dependency entry pins EXACTLY the seeded package@version`, lock.packages?.[""]?.dependencies?.[pkg] === version);

  const entryKeys = Object.keys(lock.packages ?? {}).filter((k) => k !== "");
  check(`${label}: the lock resolves at least one entry (not just the root)`, entryKeys.length > 0);

  const missingIntegrity = entryKeys.filter((k) => !/^sha512-/.test(lock.packages[k]?.integrity ?? ""));
  check(
    `${label}: every resolved entry carries a real sha512 integrity hash (${missingIntegrity.length} missing: ${missingIntegrity.slice(0, 5).join(", ")})`,
    missingIntegrity.length === 0,
  );

  const offRegistry = entryKeys.filter((k) => {
    const resolved = lock.packages[k]?.resolved;
    return typeof resolved === "string" && !resolved.startsWith("https://registry.npmjs.org/");
  });
  check(
    `${label}: every resolved URL is under registry.npmjs.org (${offRegistry.length} off-registry: ${offRegistry.slice(0, 5).join(", ")})`,
    offRegistry.length === 0,
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every bundled npm-pinned capability row's seeded package@version is tied to a real, matching committed lock asset: lockfileVersion 3, the root dependency pin matches the seed exactly, every resolved entry carries a sha512 integrity, and every resolved URL is under registry.npmjs.org."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
