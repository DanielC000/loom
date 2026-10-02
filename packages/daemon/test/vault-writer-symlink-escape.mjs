// Regression guard for card af1e0eb4 (full review of 67179c22): vault/writer.ts's `resolveInVault`
// traversal guard used to walk up to the "deepest existing ancestor" via `fs.existsSync`, which FOLLOWS a
// symlink/junction and reports "doesn't exist" when its destination is missing — i.e. it is blind to a
// DANGLING link. For a vault-relative path whose final component was a dangling symlink/junction, that
// blindness let the walk-up treat the link's own (real, existing) PARENT as the deepest existing ancestor,
// pass the containment check trivially, and hand back the dangling link's OWN path as a "safe" resolved
// target it never actually inspected — a write then lands wherever the link resolves, possibly outside the
// vault. The fix `lstat`s the final target (never `fs.existsSync`) before anything else and refuses
// outright if it's a symlink/junction, dangling or live.
// Hermetic — a fresh tmp vault/outside pair, no git init needed (the writer's commit step is
// best-effort and failure there is swallowed). Claude-free, network-free.
// Run after build: node test/vault-writer-symlink-escape.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeVaultFile, createVaultFile } from "../dist/vault/writer.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const skip = (label, reason) => console.log(`SKIP  ${label} (${reason}) — not a failure`);

const root = path.join(os.tmpdir(), `loom-vault-symlink-escape-${Date.now()}-${process.pid}`);
const vault = path.join(root, "vault");
const outside = path.join(root, "outside");
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

try {
  // ============ A. FINAL TARGET is a DANGLING FILE symlink — the real content-escape shape ============
  // Needs symlink privilege a stock (non-admin, non-Developer-Mode) Windows host denies by default; the
  // ubuntu CI runner has no such restriction and runs this for real, per the card's own DoD.
  {
    const outsideTarget = path.join(outside, "pwned-a.md");
    const link = path.join(vault, "dangling-final.md");
    let linkOk = false;
    try { fs.symlinkSync(outsideTarget, link, "file"); linkOk = true; }
    catch { /* no symlink privilege on this host */ }
    if (linkOk) {
      const r = await writeVaultFile(vault, "dangling-final.md", "PWNED-A");
      check("(A) dangling FILE symlink as final target → refused as traversal", r.ok === false && r.reason === "traversal");
      check("(A) nothing landed at the symlink's outside destination", !fs.existsSync(outsideTarget));
    } else {
      skip("(A) dangling file-symlink final target", "could not create a file symlink on this host (no privilege)");
    }
  }

  // ============ A2. FINAL TARGET is a DANGLING symlink/junction — same existsSync-blindness mechanism, ===
  // ============     but createable on Windows with NO privilege (unlike a file symlink), so this proves ==
  // ============     the fix on every host, including a stock Windows one. ===============================
  {
    const outsideTarget = path.join(outside, "nowhere-a2"); // deliberately never created: dangling
    const link = path.join(vault, "dangling-final-junction");
    fs.symlinkSync(outsideTarget, link, process.platform === "win32" ? "junction" : "file");
    check("(A2) sanity: fs.existsSync is blind to the dangling link (the exact bug mechanism)", fs.existsSync(link) === false);
    check("(A2) sanity: fs.lstatSync still sees it as a symlink", fs.lstatSync(link).isSymbolicLink() === true);
    const r = await writeVaultFile(vault, "dangling-final-junction", "PWNED-A2");
    check("(A2) dangling link as final target → refused as traversal (not a downstream fs error)", r.ok === false && r.reason === "traversal");
  }

  // ============ B. FINAL TARGET is a LIVE symlink pointing to an EXISTING file outside the vault =========
  {
    const outsideTarget = path.join(outside, "secret-b.md");
    fs.writeFileSync(outsideTarget, "TOP SECRET B\n");
    const link = path.join(vault, "live-final.md");
    let linkOk = false;
    try { fs.symlinkSync(outsideTarget, link, "file"); linkOk = true; }
    catch { /* no symlink privilege on this host */ }
    if (linkOk) {
      const r = await writeVaultFile(vault, "live-final.md", "PWNED-B");
      check("(B) live FILE symlink as final target → refused as traversal", r.ok === false && r.reason === "traversal");
      check("(B) outside file untouched", fs.readFileSync(outsideTarget, "utf8") === "TOP SECRET B\n");
    } else {
      skip("(B) live file-symlink final target", "could not create a file symlink on this host (no privilege)");
    }
  }

  // ============ C. a symlinked/junctioned PARENT dir pointing to an EXISTING outside directory ===========
  // Uses a junction on Windows (no privilege needed for a DIRECTORY link) and a plain `dir` symlink on
  // POSIX (no privilege needed there either) — the DoD's explicit "a junction ⇒ refused" case.
  {
    const outsideDir = path.join(outside, "outside-dir-c");
    fs.mkdirSync(outsideDir, { recursive: true });
    const linkDir = path.join(vault, "linked-parent-c");
    fs.symlinkSync(outsideDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    const r = await writeVaultFile(vault, "linked-parent-c/escaped.md", "PWNED-C");
    check("(C) write under a symlinked/junctioned PARENT dir pointing outside → refused as traversal", r.ok === false && r.reason === "traversal");
    check("(C) nothing landed in the real outside directory", !fs.existsSync(path.join(outsideDir, "escaped.md")));
  }

  // ============ D. CONTROL: normal create/overwrite with no link anywhere still works ======================
  {
    const w = await writeVaultFile(vault, "normal/hello.md", "hello\n");
    check("(D) CONTROL: normal nested create succeeds (non-existent final target under a real parent)", w.ok === true);
    const w2 = await writeVaultFile(vault, "normal/hello.md", "hello again\n");
    check("(D) CONTROL: normal overwrite of an existing (non-symlink) file succeeds", w2.ok === true);
    check("(D) CONTROL: content round-trips", fs.readFileSync(path.join(vault, "normal", "hello.md"), "utf8") === "hello again\n");
    const c = await createVaultFile(vault, "normal/fresh.md", "fresh\n");
    check("(D) CONTROL: createVaultFile on a non-existent final target under a real parent succeeds", c.ok === true);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveInVault refuses a symlinked/junctioned final target (dangling or live) and a symlinked/junctioned parent dir, while an ordinary create/overwrite is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
