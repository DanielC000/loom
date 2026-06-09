#!/usr/bin/env node
// Print the CHANGELOG.md section for one version, for use as GitHub Release notes.
//   node scripts/extract-changelog.mjs 0.2.0          # → that version's section on stdout
// Used by .github/workflows/release.yml (notes = this section) and by the manual runbook
// (docs/releasing.md › "Cutting a release" step 6). Exits non-zero if the section is missing, so a
// release never ships with empty/wrong notes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] || "").replace(/^v/, "").trim();
if (!version) {
  console.error("usage: node scripts/extract-changelog.mjs <version>   (e.g. 0.2.0)");
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
const lines = changelog.split(/\r?\n/);

// Section heading is `## [X.Y.Z] — date` (Keep a Changelog). Match the version inside the brackets.
const isVersionHeading = (l) => {
  const m = l.match(/^##\s+\[([^\]]+)\]/);
  return m && m[1].trim() === version;
};
const isAnyH2 = (l) => /^##\s+/.test(l);

const start = lines.findIndex(isVersionHeading);
if (start === -1) {
  console.error(`extract-changelog: no "## [${version}]" section found in CHANGELOG.md`);
  process.exit(1);
}

const body = [];
for (let i = start + 1; i < lines.length; i++) {
  if (isAnyH2(lines[i])) break;
  body.push(lines[i]);
}

// Trim leading/trailing blank lines.
while (body.length && body[0].trim() === "") body.shift();
while (body.length && body[body.length - 1].trim() === "") body.pop();

if (body.length === 0) {
  console.error(`extract-changelog: "## [${version}]" section is empty`);
  process.exit(1);
}

process.stdout.write(body.join("\n") + "\n");
