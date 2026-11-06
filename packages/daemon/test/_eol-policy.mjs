// Shared EOL-policy primitives for `working-tree-eol-guard.mjs` (the detector) and its `--fix` mode
// (card 97ddb56b). Pure fs+git helpers — no daemon, no Db. Lives in a helper module (not the guard
// itself) so `working-tree-eol-guard-fix.mjs` can run the SAME detector + repair against a throwaway
// fixture repo: the guard script scans only its own repo root and ends with process exit, so it cannot be
// imported for that. Moved here verbatim from the guard; see that file's header for the why of each rule.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listUntrackedTestFiles as listUntrackedRepoFiles } from "./fixed-wait-witness-guard.mjs";

/** Raw CRLF vs bare-LF line-ending counts of a buffer, read directly off disk — never through a git diff/
 *  status/show comparison (see the guard's own header for why those are blind to exactly this fault). */
export function countEndings(buf) {
  let crlf = 0;
  let totalLf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      totalLf++;
      if (i > 0 && buf[i - 1] === 0x0d) crlf++;
    }
  }
  return { crlf, bareLf: totalLf - crlf };
}

/** Mirrors git's own `text=auto` content-sniffing heuristic closely enough for this guard's purpose: a
 *  raw NUL byte anywhere in the content means git treats the path as binary and never applies LF/CRLF
 *  conversion to it. */
export function containsNul(buf) {
  return buf.includes(0);
}

/** The line-ending policy `.gitattributes` + `core.autocrlf` imply for a path, given its `eol`/`text`
 *  check-attr values. Returns "lf" | "crlf" | null (null = no policy — an explicit `-text`/binary path). */
export function expectedPolicy(eolAttr, textAttr, autocrlfTrue) {
  if (textAttr === "unset") return null; // explicit -text / binary attribute — git never converts it
  if (eolAttr === "lf") return "lf";
  if (eolAttr === "crlf") return "crlf";
  return autocrlfTrue ? "crlf" : "lf"; // no eol pin — falls through to the live core.autocrlf setting
}

/** Evaluates one file's actual bytes against its expected policy. `skip:true` covers both "no line-
 *  ending policy applies" (policy === null) and "the file has no newlines to have an opinion about". */
export function evaluate(buf, policy) {
  if (policy === null) return { skip: true };
  const { crlf, bareLf } = countEndings(buf);
  if (crlf === 0 && bareLf === 0) return { skip: true };
  if (policy === "crlf") return { skip: false, ok: bareLf === 0, crlf, bareLf };
  return { skip: false, ok: crlf === 0, crlf, bareLf }; // policy === "lf"
}

export function execGit(root, args, opts = {}) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "buffer", ...opts });
}

export function coreAutocrlfTrue(root) {
  let out;
  try { out = execGit(root, ["config", "--get", "core.autocrlf"]).toString("utf8").trim(); }
  catch { out = ""; } // `git config --get` exits non-zero with empty output when the key is unset
  return out === "true";
}

/** EVERY tracked path, full stop — no extension filter.
 *  @decision d854889d — never reintroduce an extension/filename allowlist here. */
export function listTrackedFiles(root) {
  const raw = execGit(root, ["ls-files", "-z"]).toString("utf8");
  return raw.split("\0").filter(Boolean);
}

/** Every non-ignored untracked path (card c3e70c20). `null` = git itself failed,
 *  `[]` = checked, found none — a caller must not conflate the two.
 *  @decision d854889d — no extension filter on this population either. */
export function listUntrackedFiles(root) {
  return listUntrackedRepoFiles(root, ".");
}

/** Parses one `git ls-files --eol -z` record's fixed-width status columns into `{i, w, attr}`. */
export function parseLsFilesEolStatus(statusPart) {
  const m = statusPart.match(/^i\/(\S*)\s+w\/(\S*)\s+attr\/(.+?)\s*$/);
  if (!m) return null;
  return { i: m[1], w: m[2], attr: m[3] };
}

/** Ground-truth `git ls-files --eol` states for the whole tracked tree.
 *  @decision d854889d — the guard cross-validates every `containsNul` binary skip against these; never
 *  treat `containsNul` as self-certifying. */
export function resolveTrackedGitEolStates(root) {
  const map = new Map();
  let out;
  try {
    out = execFileSync("git", ["-C", root, "ls-files", "--eol", "-z"], { encoding: "utf8" });
  } catch {
    return map;
  }
  for (const rec of out.split("\0").filter(Boolean)) {
    const tabIdx = rec.indexOf("\t");
    if (tabIdx === -1) continue;
    const parsed = parseLsFilesEolStatus(rec.slice(0, tabIdx));
    if (parsed) map.set(rec.slice(tabIdx + 1), parsed);
  }
  return map;
}

/** Batched `git check-attr eol text` over every path at once via stdin (never argv). */
export function checkAttrsBatch(root, files) {
  const map = new Map();
  if (files.length === 0) return map;
  const input = Buffer.from(files.map((f) => `${f}\0`).join(""), "utf8");
  const out = execFileSync("git", ["-C", root, "check-attr", "-z", "--stdin", "eol", "text"], {
    input, encoding: "buffer",
  }).toString("utf8");
  const tokens = out.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const [file, attr, value] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    let entry = map.get(file);
    if (!entry) { entry = {}; map.set(file, entry); }
    entry[attr] = value;
  }
  return map;
}

/** The guard's section (B) scan, parametrised on the repo root: every tracked AND untracked-but-present
 *  path, raw bytes vs the policy `.gitattributes` + live `core.autocrlf` imply. */
export function scanEolViolations(root) {
  const autocrlfTrue = coreAutocrlfTrue(root);
  const files = listTrackedFiles(root);
  const untrackedFiles = listUntrackedFiles(root);
  const scanTargets = [
    ...files.map((rel) => ({ rel, tracked: true })),
    ...(untrackedFiles || []).map((rel) => ({ rel, tracked: false })),
  ];
  const attrs = checkAttrsBatch(root, scanTargets.map((t) => t.rel));
  const violations = [];
  const skippedBinary = [];
  let lfPinnedCount = 0;
  let crlfPinnedCount = 0;
  for (const { rel, tracked } of scanTargets) {
    const attr = attrs.get(rel) || {};
    if (tracked && attr.eol === "lf") lfPinnedCount++;
    if (tracked && attr.eol === "crlf") crlfPinnedCount++;
    let buf;
    try { buf = fs.readFileSync(path.join(root, rel)); } catch { continue; } // gone since enumeration
    if (containsNul(buf)) { if (tracked) skippedBinary.push(rel); continue; }
    const policy = expectedPolicy(attr.eol, attr.text, autocrlfTrue);
    const result = evaluate(buf, policy);
    if (result.skip) continue;
    if (!result.ok) violations.push({ file: rel, tracked, policy, crlf: result.crlf, bareLf: result.bareLf });
  }
  return { autocrlfTrue, files, untrackedFiles, scanTargets, violations, skippedBinary, lfPinnedCount, crlfPinnedCount };
}

/** Rewrites a buffer's line endings to `policy`. Normalises to LF first so a MIXED file also converges. */
export function convertToPolicy(buf, policy) {
  const lf = Buffer.from(buf.toString("latin1").split("\r\n").join("\n"), "latin1");
  if (policy === "lf") return lf;
  return Buffer.from(lf.toString("latin1").split("\n").join("\r\n"), "latin1");
}

/** `--fix`: rewrites ONLY the given violations (as returned by `scanEolViolations`) to their policy.
 *  Refuses (reports `skipped`) any path that escapes `root`, any symlink, and any non-regular file, so a
 *  flagged path can never cause a write outside the worktree. Never touches the git index: the index blob
 *  is LF-normalised by git's clean filter whatever the working-tree bytes are, so a file that is already
 *  staged stays consistent without a re-`git add`. Returns `{ changed, skipped }`. */
export function fixViolations(root, violations) {
  const rootReal = fs.realpathSync(root);
  const changed = [];
  const skipped = [];
  for (const v of violations) {
    const abs = path.resolve(rootReal, v.file);
    const rel = path.relative(rootReal, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) { skipped.push({ file: v.file, reason: "outside the worktree" }); continue; }
    let st;
    try { st = fs.lstatSync(abs); } catch { skipped.push({ file: v.file, reason: "gone" }); continue; }
    if (!st.isFile()) { skipped.push({ file: v.file, reason: "not a regular file (symlink or special)" }); continue; }
    const before = fs.readFileSync(abs);
    const after = convertToPolicy(before, v.policy);
    if (before.equals(after)) continue;
    fs.writeFileSync(abs, after);
    changed.push({ file: v.file, policy: v.policy, tracked: v.tracked, crlf: v.crlf, bareLf: v.bareLf });
  }
  return { changed, skipped };
}
