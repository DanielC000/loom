// Source-text sync check (not a behaviour test): the issue-tracker URL the bundled platform-lead and
// setup-assistant skills tell an agent to use must equal the `bugs.url` the published loomctl package
// declares in scripts/build-npm-package.mjs, so the two cannot drift. Reads files only; no daemon, no DB.
// Run: node test/skill-issue-tracker-url-sync.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const BUGS_RE = /bugs:\s*\{\s*url:\s*"([^"]+)"\s*\}/;
const ISSUES_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues/g;

const pkgSrc = fs.readFileSync(path.join(repoRoot, "scripts", "build-npm-package.mjs"), "utf8");
const bugsUrl = BUGS_RE.exec(pkgSrc)?.[1];
check("build-npm-package.mjs declares a bugs.url", typeof bugsUrl === "string" && bugsUrl.length > 0);

const skillUrls = (text) => [...new Set(text.match(ISSUES_URL_RE) ?? [])];
for (const name of ["platform-lead", "setup-assistant"]) {
  const text = fs.readFileSync(path.join(here, "..", "assets", "skills", name, "SKILL.md"), "utf8");
  const urls = skillUrls(text);
  check(`${name}: names exactly one issues URL`, urls.length === 1);
  check(`${name}: that URL equals the loomctl bugs.url`, urls.length === 1 && urls[0] === bugsUrl);
}

// Negative control: a drifted URL in skill text must be caught by the same comparison.
const drifted = skillUrls("file at https://github.com/someone-else/loom/issues please");
check("control: a drifted URL is detected as unequal", drifted.length === 1 && drifted[0] !== bugsUrl);
// Control for the extractor: it returns nothing on text with no issues URL.
check("control: extractor returns none when no URL is present", skillUrls("no link here").length === 0);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall passed");
process.exit(failures ? 1 : 0);
