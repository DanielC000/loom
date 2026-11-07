import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 004e9b45. Test-only: pins boot's handling of SEVERAL tmp residues for ONE hash.
//
// Origin: a Code Review probe (card 8596ddfb) kept one repoPath from two tmp residues, a survivor holding a
// foreign token and a deletable one, and saw a fresh boot block with the survivor sorted FIRST but NOT with
// it sorted LAST. Investigated: NOT a boot bug. The "last" survivor was named `...tmp-9999-zzzz`, and `zzzz` is
// not hex, so it fails boot's strict tmp shape (`/\.json\.tmp-\d+(-[0-9a-f]+)?$/`) and is never read at all.
// The writer only ever emits `.tmp-<pid>-<8 hex>`, so that shape cannot occur in production.
//
// Pinned here so nobody re-files it:
//   (1) two same-hash tmp residues with VALID writer-shaped names, in BOTH readdir orders: the reboot blocks
//       the repo and the promoted final carries the UNION of both files' tokens (order-independent), with
//       every tmp consumed.
//   (2) a lone non-hex-suffixed (`zzzz`) file is NOT armed and is left untouched, while the identical bytes
//       under a hex-suffixed name DO block (control: the skip is the name shape, not the content).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-004e9b45-boot-same-hash-tmp-union.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("lq004e-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mqHref = pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-quarantine.js")).href;
const { enterMergeQuarantine, MERGE_QUARANTINE_DIR } = await import(mqHref);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`ok - ${name}`);
  else { failures++; console.log(`FAIL - ${name}${detail === undefined ? "" : ` :: ${detail}`}`); }
}

let bootCounter = 0;
const freshBoot = async () => await import(`${mqHref}?b=${++bootCounter}`);
const quiet = (fn) => {
  const e = console.error, w = console.warn, l = console.log;
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.error = e; console.warn = w; console.log = l; }
};
function makeRepo(tag) {
  const repo = mkdtempManaged(`lq004e-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "lq004e@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "lq004e"], { cwd: repo });
  commitAll(repo, "init", "-c user.email=lq004e@loom -c user.name=lq004e");
  return repo;
}
const wipe = () => { for (const f of fs.readdirSync(MERGE_QUARANTINE_DIR)) fs.rmSync(path.join(MERGE_QUARANTINE_DIR, f), { force: true, recursive: true }); };
const rec = (repo, reason, tokens) => JSON.stringify({ repoPath: repo, branch: "p", reason, enteredAt: Date.now(), tokens });

// The repo's REAL latch hash: raise once, read the one final's name, then clear the dir so ONLY the tmps we
// write remain for the boot under test.
function realHashFor(repo) {
  quiet(() => enterMergeQuarantine(repo, "b", "seed"));
  const finals = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json"));
  if (finals.length !== 1) throw new Error(`expected exactly one seed final, got ${JSON.stringify(finals)}`);
  const hash = finals[0].slice(0, -".json".length);
  wipe();
  return hash;
}
const bootAndPeek = async (repo) => {
  const b = await freshBoot();
  quiet(() => b.reenterMergeQuarantinesAtBoot([repo]));
  return { verdict: b.assertRepoNotQuarantined(repo), files: fs.readdirSync(MERGE_QUARANTINE_DIR) };
};
const tokensOf = (f) => JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).tokens;

// (1) two valid, writer-shaped residues of ONE hash, both orders.
for (const [variant, survivorSuffix, otherSuffix] of [
  ["survivorFirst", "1111-aaaaaaaa", "9999-ffffffff"], // survivor sorts BEFORE the subset residue
  ["survivorLast", "9999-ffffffff", "1111-aaaaaaaa"],  // survivor sorts AFTER the subset residue
]) {
  const repo = makeRepo(variant);
  const hash = realHashFor(repo);
  const shared = `shared-${variant}`, foreign = `foreign-${variant}`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${survivorSuffix}`), rec(repo, "survivor", [shared, foreign]));
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${otherSuffix}`), rec(repo, "subset", [shared]));
  const sortedNames = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check(`[${variant}] fixture: survivor sorts ${variant === "survivorFirst" ? "first" : "last"}`,
    sortedNames[variant === "survivorFirst" ? 0 : 1].endsWith(survivorSuffix), JSON.stringify(sortedNames));
  const { verdict, files } = await bootAndPeek(repo);
  check(`[${variant}] reboot BLOCKS the repo`, verdict.ok === false, JSON.stringify(verdict));
  const finals = files.filter((f) => f.endsWith(".json"));
  check(`[${variant}] exactly one promoted final, no tmp left`, finals.length === 1 && files.length === 1, JSON.stringify(files));
  const toks = finals.length === 1 ? tokensOf(finals[0]) : [];
  check(`[${variant}] promoted final holds the UNION (shared + foreign)`,
    toks.length === 2 && toks.includes(shared) && toks.includes(foreign), JSON.stringify(toks));
  wipe();
}

// (2) a non-hex-suffixed file is outside boot's strict tmp shape: not armed, left untouched.
{
  const repo = makeRepo("zzzz");
  const hash = realHashFor(repo);
  const bytes = rec(repo, "non-hex name", ["tok-zzzz"]);
  const zName = `${hash}.json.tmp-9999-zzzz`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, zName), bytes);
  const alone = await bootAndPeek(repo);
  check("[zzzz] a lone non-hex-suffixed file is NOT armed (repo not blocked)", alone.verdict.ok === true, JSON.stringify(alone.verdict));
  check("[zzzz] and is left on disk byte-for-byte", alone.files.length === 1 && alone.files[0] === zName
    && fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, zName), "utf8") === bytes, JSON.stringify(alone.files));
  wipe();
  // control: identical bytes under a hex-suffixed name DO block.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-9999-ffffffff`), bytes);
  const ctl = await bootAndPeek(repo);
  check("[zzzz] control: identical bytes with a hex suffix DO block", ctl.verdict.ok === false, JSON.stringify(ctl.verdict));
  wipe();
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
