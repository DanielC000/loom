// Unit test for the vault browser's path guards. readVaultFile is a pure function, so this
// needs no daemon — it imports the compiled module directly and runs against temp dirs.
// Run after build: node test/vault-browser.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readVaultFile } from "../dist/vault/browser.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-vault-test-${Date.now()}`);
const vault = path.join(root, "vault");
const outside = path.join(root, "outside");
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(vault, "note.md"), "# inside\nhello vault\n");
fs.writeFileSync(path.join(outside, "secret.md"), "TOP SECRET — outside the vault\n");

try {
  // 1. a normal in-vault read still works.
  check("normal in-vault read returns content", (readVaultFile(vault, "note.md") ?? "").includes("hello vault"));

  // 2. lexical ../ traversal is rejected (the pre-existing guard).
  check("'../' traversal returns null", readVaultFile(vault, "../outside/secret.md") === null);
  check("backslash '..' traversal returns null", readVaultFile(vault, "..\\outside\\secret.md") === null);

  // 3. a symlink INSIDE the vault that points OUTSIDE is rejected (the realpath guard).
  //    Lexically `vault/link/secret.md` looks in-bounds; only realpath reveals it escapes.
  //    Use a directory junction: on Windows it needs no elevation (unlike file symlinks),
  //    and it exercises the exact case the lexical check misses.
  const linkDir = path.join(vault, "link");
  let linked = false;
  try { fs.symlinkSync(outside, linkDir, "junction"); linked = true; }
  catch { try { fs.symlinkSync(outside, linkDir, "dir"); linked = true; } catch { /* no privilege */ } }

  if (linked) {
    check("in-vault symlink pointing outside returns null", readVaultFile(vault, "link/secret.md") === null);
  } else {
    console.log("SKIP  symlink case — could not create a link/junction without elevation");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS — vault path guards hold." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
