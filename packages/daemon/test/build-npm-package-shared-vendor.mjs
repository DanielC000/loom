// Card 884c8d56 (Code Review round, then round 2) — hermetic fixture test for the @loom/shared vendoring
// pair in scripts/build-npm-package.mjs: the NARROW rewrite (rewriteSharedSpecifiers, only the exact
// `from "@loom/shared"` form tsc emits), the WIDENED post-rewrite survivor check
// (survivingSharedImportSpecifiers, every specifier FORM a surviving reference could take), and (round 2)
// forbiddenBundledKeys(), the pure check the isMain block's on-disk bundledDependencies re-read now calls
// rather than re-deriving inline. Exercises ONLY the pure, exported functions against a throwaway
// fixture dir / plain objects — never the real packaging side effects (no `pnpm build`, no `npm pack`) —
// so it stays fast and hermetic, same posture as build-npm-package-stray-shim-guard.mjs.
import fs from "node:fs";
import path from "node:path";
import {
  rewriteSharedSpecifiers,
  survivingSharedImportSpecifiers,
  forbiddenBundledKeys,
} from "../../../scripts/build-npm-package.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const fixtureDir = mkdtempManaged("loom-build-npm-package-shared-vendor-");
const orchDir = path.join(fixtureDir, "orchestration");
fs.mkdirSync(orchDir, { recursive: true });

// The REWRITE target: the exact `from "@loom/shared"` form tsc emits for a value import/re-export —
// the one form rewriteSharedSpecifiers() actually rewrites.
const fromFormPath = path.join(orchDir, "merge-gate-interval.js");
fs.writeFileSync(
  fromFormPath,
  'import { resolveMergeGateCadence } from "@loom/shared";\n\nexport { resolveMergeGateCadence };\n',
);

// The OTHER specifier forms the WIDENED survivor check must catch — each a distinct way a reference to
// the un-vendored `@loom/shared` could survive the (deliberately narrow) rewrite: a bare side-effect
// import, a dynamic import(), a require(), either quote style, and a subpath.
const otherForms = {
  "side-effect-import-double.js": 'import "@loom/shared";\n',
  "side-effect-import-single.js": "import '@loom/shared';\n",
  "dynamic-import-double.js": 'const mod = await import("@loom/shared");\n',
  "dynamic-import-single.js": "const mod = await import('@loom/shared');\n",
  "require-double.js": 'const mod = require("@loom/shared");\n',
  "require-single.js": "const mod = require('@loom/shared');\n",
  "subpath-from.js": 'import { helper } from "@loom/shared/util";\n',
};
for (const [name, content] of Object.entries(otherForms)) {
  fs.writeFileSync(path.join(fixtureDir, name), content);
}

// NEGATIVE fixtures — must survive both the rewrite AND the widened survivor check untouched and
// unflagged. dataStringPath mirrors the real orchestration/deploy-packages.ts restart-mapping entry
// (`{ name: "@loom/shared", ... }`, a DATA string, never a module specifier); commentMentionPath mirrors
// an ordinary prose comment naming the package without a preceding from/import/require(.
const dataStringPath = path.join(fixtureDir, "data-string.js");
fs.writeFileSync(
  dataStringPath,
  'export const DEPLOY_PACKAGES = [\n  { name: "@loom/shared", srcPathspec: "packages/shared/src", restartRequired: true },\n];\n',
);
const commentMentionPath = path.join(fixtureDir, "comment-mention.js");
fs.writeFileSync(
  commentMentionPath,
  "// Note: @loom/shared is the private workspace package, vendored outside node_modules.\nexport const noop = true;\n",
);

// .d.ts restriction — the shipped .d.ts files also carry the from-form (tsc never rewrites type-only
// imports, and this build doesn't either), but they are type-only declarations with no runtime import
// resolution, so BOTH functions restrict their scan to `.js` files and must never touch this one.
const dtsPath = path.join(fixtureDir, "type-only.d.ts");
const dtsOriginal = 'import type { Foo } from "@loom/shared";\n';
fs.writeFileSync(dtsPath, dtsOriginal);

const read = (p) => fs.readFileSync(p, "utf8");

// --- 1. The rewrite fixes the from-form -------------------------------------------------------------
const rewritten = rewriteSharedSpecifiers(fixtureDir);
check(
  "rewriteSharedSpecifiers() reports the from-form file as rewritten",
  rewritten.includes("orchestration/merge-gate-interval.js"),
);
check(
  "the from-form file now imports from \"#loom-shared\" instead of \"@loom/shared\"",
  read(fromFormPath).includes('from "#loom-shared"') && !read(fromFormPath).includes('from "@loom/shared"'),
);
check(
  "rewriteSharedSpecifiers() did NOT touch any of the other-form files",
  Object.keys(otherForms).every((name) => !rewritten.includes(name)),
);
check("rewriteSharedSpecifiers() did NOT touch the data-string file", !rewritten.includes("data-string.js"));
check("rewriteSharedSpecifiers() did NOT touch the comment-mention file", !rewritten.includes("comment-mention.js"));
check(
  "rewriteSharedSpecifiers() did NOT touch the .d.ts file (restricted to .js)",
  read(dtsPath) === dtsOriginal,
);

// --- 2. The widened survivor check flags every OTHER form, post-rewrite ----------------------------
// Mirrors the real packaging order: survivingSharedImportSpecifiers() runs AFTER rewriteSharedSpecifiers()
// in scripts/build-npm-package.mjs's own isMain block (step 5a).
const surviving = survivingSharedImportSpecifiers(fixtureDir);
for (const name of Object.keys(otherForms)) {
  check(`survivor check flags ${name}`, surviving.includes(name));
}
check(
  "survivor check no longer flags the (already rewritten) from-form file",
  !surviving.includes("orchestration/merge-gate-interval.js"),
);

// --- 3. The data string and the comment are untouched AND unflagged --------------------------------
check(
  "the data-string file's content is byte-for-byte unchanged",
  read(dataStringPath) === 'export const DEPLOY_PACKAGES = [\n  { name: "@loom/shared", srcPathspec: "packages/shared/src", restartRequired: true },\n];\n',
);
check("the data-string file is NOT flagged by the survivor check", !surviving.includes("data-string.js"));
check(
  "the comment-mention file's content is byte-for-byte unchanged",
  read(commentMentionPath) === "// Note: @loom/shared is the private workspace package, vendored outside node_modules.\nexport const noop = true;\n",
);
check("the comment-mention file is NOT flagged by the survivor check", !surviving.includes("comment-mention.js"));
check("the .d.ts file is NOT flagged by the survivor check (restricted to .js)", !surviving.includes("type-only.d.ts"));

// --- 4. forbiddenBundledKeys() — both spellings, an empty array still counts, a clean pkg passes -----
check(
  "flags bundledDependencies when set to a non-empty array",
  JSON.stringify(forbiddenBundledKeys({ name: "loomctl", bundledDependencies: ["@loom/shared"] })) ===
    JSON.stringify(["bundledDependencies"]),
);
check(
  "flags bundleDependencies (the alias spelling) when set to a non-empty array",
  JSON.stringify(forbiddenBundledKeys({ name: "loomctl", bundleDependencies: ["@loom/shared"] })) ===
    JSON.stringify(["bundleDependencies"]),
);
check(
  "flags bundledDependencies even when it is an EMPTY array — presence alone is the trigger (npm/cli#7355)",
  JSON.stringify(forbiddenBundledKeys({ name: "loomctl", bundledDependencies: [] })) ===
    JSON.stringify(["bundledDependencies"]),
);
check(
  "flags BOTH keys when both are present on the same object",
  JSON.stringify(forbiddenBundledKeys({ name: "loomctl", bundledDependencies: [], bundleDependencies: [] })) ===
    JSON.stringify(["bundledDependencies", "bundleDependencies"]),
);
check(
  "a clean package.json (neither key present) passes — returns an empty array",
  forbiddenBundledKeys({ name: "loomctl", dependencies: { "better-sqlite3": "1.0.0" } }).length === 0,
);

console.log(`\n${failures === 0 ? "✅" : "❌"} build-npm-package-shared-vendor: ${failures} check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);
