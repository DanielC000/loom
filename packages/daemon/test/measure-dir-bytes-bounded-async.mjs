import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5eace211 (Code Review MINOR 5) — direct unit coverage of `measureDirBytesBoundedAsync` (paths.ts),
// the async/bounded walk `served_status`/`project_archive` actually call. Before this file, nothing
// exercised its `truncated:true` path or its symlink/junction skip directly — both were only ever implied
// by the real-data (always-false) assertions in project-work-dir-served-status.mjs.
//
// Proves:
//   (1) an entry-count cap of 1, against a dir with more than one real file, produces truncated:true —
//       and the partial `bytes` figure it returns is a REAL subset (not zero, not the full total).
//   (2) a generous cap against the SAME dir produces truncated:false and the FULL byte total — the
//       negative control proving (1) is a genuine cap effect, not something always true.
//   (3) a symlink/junction entry is SKIPPED — its target's real bytes never get counted, even though the
//       target directory genuinely exists on disk with real content. Win32: a directory junction (no
//       elevation needed); POSIX: a plain directory symlink.
//   (4) an unreadable/missing root contributes {bytes:0, truncated:false}, never a thrown rejection.
//
// Run: 1) build (turbo builds shared first), 2) node test/measure-dir-bytes-bounded-async.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mdbba-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { measureDirBytesBoundedAsync } = await import("../dist/paths.js");

try {
  // ===================== (1)/(2) truncated:true via a tight entry cap, vs. a generous one =====================
  const multiDir = path.join(tmpHome, "multi");
  fs.mkdirSync(multiDir, { recursive: true });
  fs.writeFileSync(path.join(multiDir, "a.bin"), Buffer.alloc(1000, 1));
  fs.writeFileSync(path.join(multiDir, "b.bin"), Buffer.alloc(2000, 2));
  fs.writeFileSync(path.join(multiDir, "c.bin"), Buffer.alloc(3000, 3));
  const fullTotal = 1000 + 2000 + 3000;

  const tight = await measureDirBytesBoundedAsync(multiDir, { maxEntries: 1, maxMs: 5_000 });
  check("(1) maxEntries:1 against 3 real files ⇒ truncated:true", tight.truncated === true);
  check("(1) the partial bytes figure is a REAL subset — non-zero, strictly less than the full total", tight.bytes > 0 && tight.bytes < fullTotal);

  const generous = await measureDirBytesBoundedAsync(multiDir, { maxEntries: 200_000, maxMs: 5_000 });
  check("(2) negative control — a generous cap against the SAME dir ⇒ truncated:false", generous.truncated === false);
  check("(2) negative control — the generous cap returns the FULL byte total", generous.bytes === fullTotal);

  // ===================== (3) symlink/junction skip =====================
  const walkedRoot = path.join(tmpHome, "walked-root");
  const realTarget = path.join(tmpHome, "real-target-outside-walk");
  fs.mkdirSync(walkedRoot, { recursive: true });
  fs.mkdirSync(realTarget, { recursive: true });
  fs.writeFileSync(path.join(realTarget, "payload.bin"), Buffer.alloc(5000, 7));
  // Also a REAL (non-symlinked) file directly inside the walked root, so the walk has something genuine
  // to count — proving a 0 result below means "skipped the link", not "found nothing at all".
  fs.writeFileSync(path.join(walkedRoot, "real.bin"), Buffer.alloc(400, 8));

  const linkPath = path.join(walkedRoot, "link-to-real-target");
  let symlinkCreated = false;
  try {
    fs.symlinkSync(realTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
    symlinkCreated = true;
  } catch (e) {
    console.log(`WARN  SKIP  (3) could not create a ${process.platform === "win32" ? "junction" : "symlink"} on this host (${e?.message ?? e}) — symlink-skip assertions below are skipped, not failed.`);
  }

  if (symlinkCreated) {
    const withLink = await measureDirBytesBoundedAsync(walkedRoot, { maxEntries: 200_000, maxMs: 5_000 });
    check("(3) precondition — the real, non-symlinked file in the walked root IS counted", withLink.bytes >= 400);
    check("(3) THE SKIP: the symlink/junction's target bytes (5000) are NOT counted — total stays at the real file alone", withLink.bytes === 400);
    check("(3) not truncated by this (small, well within bounds)", withLink.truncated === false);
  }

  // ===================== (4) unreadable/missing root — never throws =====================
  const missing = await measureDirBytesBoundedAsync(path.join(tmpHome, "does-not-exist"), { maxEntries: 200_000, maxMs: 5_000 });
  check("(4) a missing root contributes {bytes:0, truncated:false}, not a thrown rejection", missing.bytes === 0 && missing.truncated === false);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — measureDirBytesBoundedAsync: a tight entry cap produces a genuine truncated:true with a real partial sum (never the full total), a generous cap on the same dir produces the full untruncated total (negative control), a symlink/junction entry's target bytes are never counted even though they genuinely exist on disk, and a missing root degrades to a clean zero rather than throwing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
