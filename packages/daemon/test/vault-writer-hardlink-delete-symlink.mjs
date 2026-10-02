// Regression guard for card b2fde796 (Code Review c2a63924 of af1e0eb4, 2026-10-02).
//
// 1. A HARD LINK inside the vault pointing at an outside file passed resolveInVault's lstat/realpath
//    checks (it IS a regular file, at an in-vault path — those guard a symlink escape, not a shared-inode
//    one). writeVaultFile then truncated and overwrote the OUTSIDE inode through the vault's own link.
//    Fix: refuse an existing overwrite target with stat.nlink > 1, checked on the SAME open fd the write
//    would use (never a separate lstat-then-writeFileSync) to close the check-to-write TOCTOU window.
// 2. LEAD RULING: af1e0eb4 made resolveInVault refuse DELETE of ANY symlink final target too (reported as
//    "traversal") — but rmSync/unlinkSync on a link removes only the link itself, never the link's
//    target, so there is no escape to prevent on delete. Fix: deleteVaultFile now uses a DELETE-specific
//    resolver (resolveInVaultForDelete) that unlinks a final-component symlink directly, lstat-based,
//    without following it. Write-through-a-link stays refused (unchanged, see vault-writer-symlink-
//    escape.mjs).
// 3. An intermediate DANGLING DIR-LINK (vault/i1 -> missing outside/newdir) must still create nothing
//    outside the vault for a WRITE under it (resolveInVault's existing ancestor walk-up, unaffected by
//    this card — verified here as a direct repro rather than assumed).
//
// Hard links need no elevated privilege on NTFS or POSIX (verified empirically on this host), so case 1
// always runs. Symlink creation needs privilege on a stock Windows host (no admin / Developer Mode) —
// those sub-cases SKIP cleanly there and run for real on the ubuntu CI runner, matching every sibling
// symlink test in this suite (see vault-writer-symlink-escape.mjs).
// Hermetic — a fresh tmp vault/outside pair, no git init needed (the writer's commit step is best-effort
// and failure there is swallowed). Claude-free, network-free.
// Run after build: node test/vault-writer-hardlink-delete-symlink.mjs
import fs from "node:fs";
import path from "node:path";
import { writeVaultFile, deleteVaultFile } from "../dist/vault/writer.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const skip = (label, reason) => console.log(`SKIP  ${label} (${reason}) — not a failure`);

const root = mkdtempManaged("loom-vault-hardlink-delete-symlink-");
const vault = path.join(root, "vault");
const outside = path.join(root, "outside");
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

// ============ 1. HARD-LINKED OVERWRITE TARGET is refused, and the shared inode is untouched ============
{
  const outsideTarget = path.join(outside, "hard.md");
  const link = path.join(vault, "h.md");
  fs.writeFileSync(outsideTarget, "ORIGINAL\n");
  fs.linkSync(outsideTarget, link);
  check("(1) sanity: the vault path and the outside path share an inode (nlink === 2)", fs.statSync(link).nlink === 2 && fs.statSync(outsideTarget).nlink === 2);

  const r = await writeVaultFile(vault, "h.md", "PWNED-H\n");
  check("(1) hard-linked overwrite target → refused with reason 'hard-link'", r.ok === false && r.reason === "hard-link");
  check("(1) the outside file (shared inode) was NOT truncated or overwritten", fs.readFileSync(outsideTarget, "utf8") === "ORIGINAL\n");
  check("(1) the vault's own link side reads the SAME untouched content (same inode)", fs.readFileSync(link, "utf8") === "ORIGINAL\n");

  // 1b. CONTROL: an ordinary (nlink === 1) overwrite is unaffected by the new check.
  const ctrl = path.join(vault, "ordinary.md");
  fs.writeFileSync(ctrl, "first\n");
  check("(1b) CONTROL sanity: ordinary file has nlink === 1", fs.statSync(ctrl).nlink === 1);
  const rc = await writeVaultFile(vault, "ordinary.md", "second\n");
  check("(1b) CONTROL: an ordinary (non-hard-linked) overwrite still succeeds", rc.ok === true);
  check("(1b) CONTROL: content actually updated", fs.readFileSync(ctrl, "utf8") === "second\n");

  // 1c. decision: DELETING a hard-linked vault path is NOT refused — unlink only removes the vault's own
  // directory entry; the shared inode (and the outside file's own entry pointing at it) is untouched.
  const rd = await deleteVaultFile(vault, "h.md");
  check("(1c) deleting a hard-linked vault path succeeds (unlink, not overwrite)", rd.ok === true);
  check("(1c) the vault-side link is gone", !fs.existsSync(link));
  check("(1c) the outside file (same inode) is still present with its original content", fs.readFileSync(outsideTarget, "utf8") === "ORIGINAL\n");
}

// ============ 2. DELETE of an in-vault alias SYMLINK removes only the link ============
{
  const real = path.join(vault, "real.md");
  const alias = path.join(vault, "alias.md");
  fs.writeFileSync(real, "the real note\n");
  let linkOk = false;
  try { fs.symlinkSync(real, alias, "file"); linkOk = true; }
  catch { /* no symlink privilege on this host */ }

  if (linkOk) {
    check("(2) sanity: alias.md is a symlink", fs.lstatSync(alias).isSymbolicLink());
    const r = await deleteVaultFile(vault, "alias.md");
    check("(2) deleting an in-vault alias symlink succeeds (not refused as traversal)", r.ok === true);
    check("(2) the alias link itself is gone", !fs.existsSync(alias) && !(() => { try { fs.lstatSync(alias); return true; } catch { return false; } })());
    check("(2) the REAL target file (what the link pointed at) is untouched", fs.existsSync(real) && fs.readFileSync(real, "utf8") === "the real note\n");

    // Write THROUGH a link must stay refused (the asymmetry this card records) — re-create the alias
    // and confirm writeVaultFile still refuses it even though delete just proved the link itself is gone.
    fs.symlinkSync(real, alias, "file");
    const w = await writeVaultFile(vault, "alias.md", "PWNED-THROUGH-ALIAS\n");
    check("(2) write THROUGH the same alias path is still refused (write/delete asymmetry holds)", w.ok === false && w.reason === "traversal");
    check("(2) the real file was not modified by the refused write", fs.readFileSync(real, "utf8") === "the real note\n");
  } else {
    skip("(2) in-vault alias symlink delete", "could not create a file symlink on this host (no privilege)");
  }
}

// ============ 2b. DELETE of a DANGLING planted link (outside, missing) removes only the link ============
{
  const outsideTarget = path.join(outside, "nowhere-2b.md"); // deliberately never created: dangling
  const link = path.join(vault, "dangling-delete.md");
  let linkOk = false;
  try { fs.symlinkSync(outsideTarget, link, "file"); linkOk = true; }
  catch { /* no symlink privilege on this host */ }

  if (linkOk) {
    check("(2b) sanity: fs.existsSync is blind to the dangling link", fs.existsSync(link) === false);
    const r = await deleteVaultFile(vault, "dangling-delete.md");
    check("(2b) deleting a dangling planted link succeeds (not 'not-found', not 'traversal')", r.ok === true);
    check("(2b) the dangling link itself is gone", !(() => { try { fs.lstatSync(link); return true; } catch { return false; } })());
    check("(2b) nothing was ever created at the (nonexistent) outside destination", !fs.existsSync(outsideTarget));
  } else {
    skip("(2b) dangling planted link delete", "could not create a file symlink on this host (no privilege)");
  }
}

// ============ 3. An intermediate DANGLING DIR-LINK creates nothing outside on WRITE ============
{
  const outsideDir = path.join(outside, "newdir-3"); // deliberately never created: dangling
  const link = path.join(vault, "i1");
  // 'junction' needs no elevation on Windows; a plain 'dir' symlink needs none on POSIX either, so this
  // case always runs (mirrors vault-writer-symlink-escape.mjs's case (C)).
  fs.symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
  check("(3) sanity: the intermediate dir-link is dangling (existsSync blind to it)", fs.existsSync(link) === false);

  const r = await writeVaultFile(vault, "i1/newfile.md", "PWNED-I1\n");
  check("(3) write under an intermediate dangling dir-link is refused (ok:false)", r.ok === false);
  check("(3) nothing was created at the (nonexistent) outside destination", !fs.existsSync(outsideDir));
  check("(3) the outside root itself gained no new entries", fs.readdirSync(outside).every((f) => f !== "newdir-3"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — hard-linked overwrite targets are refused (checked on the same open fd, TOCTOU-safe), deleting a hard-linked vault path still succeeds (unlink only), a final-component symlink is unlinked directly on delete (without following) while write-through-a-link stays refused, and an intermediate dangling dir-link still creates nothing outside on write."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
