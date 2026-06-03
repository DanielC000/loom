// Unit test for the vault WRITER (edit/create/delete + commit) and its path-traversal guard.
// Claude-free: imports the compiled modules directly and runs against a temp git vault.
// Run after build: node test/vault-writer.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeVaultFile, createVaultFile, deleteVaultFile } from "../dist/vault/writer.js";
import { readVaultFile } from "../dist/vault/browser.js";
import { commitVault } from "../dist/vault/versioner.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vault-writer-"));
fs.mkdirSync(path.join(root, "vault"));
fs.mkdirSync(path.join(root, "outside"));
// realpath so the path matches what `git rev-parse --show-toplevel` reports (symlinked tmp,
// drive-letter case) — otherwise commitVault's externally-managed check could misfire.
const vault = fs.realpathSync(path.join(root, "vault"));
const outside = fs.realpathSync(path.join(root, "outside"));
fs.writeFileSync(path.join(outside, "secret.md"), "TOP SECRET — outside the vault\n");

const git = (...args) => execFileSync("git", args, { cwd: vault, stdio: ["ignore", "pipe", "pipe"] }).toString();
// Init the vault as its own repo with a test identity so commitVault's commits succeed in isolation.
git("init");
git("config", "user.email", "loom-test@example.com");
git("config", "user.name", "loom-test");

try {
  // 1. write round-trips: write a NEW (nested) file, then read it back via the reader.
  const w = await writeVaultFile(vault, "notes/hello.md", "# hello\nfrom the writer\n");
  check("write returns ok", w.ok === true);
  check("write committed", w.ok && w.committed === true);
  check("write round-trips via reader", (readVaultFile(vault, "notes/hello.md") ?? "").includes("from the writer"));

  // 2. overwrite an existing file works.
  await writeVaultFile(vault, "notes/hello.md", "# hello\nedited\n");
  check("overwrite round-trips", (readVaultFile(vault, "notes/hello.md") ?? "").includes("edited"));

  // 3. create a new file works; creating an existing one is rejected (never clobbers).
  check("create returns ok", (await createVaultFile(vault, "fresh.md", "fresh\n")).ok === true);
  const dup = await createVaultFile(vault, "fresh.md", "clobber\n");
  check("create on existing rejected (409)", dup.ok === false && dup.reason === "exists");
  check("create did not clobber", (readVaultFile(vault, "fresh.md") ?? "").includes("fresh"));

  // 4. delete works.
  check("delete returns ok", (await deleteVaultFile(vault, "fresh.md")).ok === true);
  check("deleted file is gone", readVaultFile(vault, "fresh.md") === null);

  // 5. PATH-TRAVERSAL is rejected — NOTHING is written outside the vault root.
  const outsideBefore = JSON.stringify(fs.readdirSync(outside).sort());
  const rel = await writeVaultFile(vault, "../outside/evil.md", "PWNED");
  check("'../' write rejected", rel.ok === false && rel.reason === "traversal");
  const bs = await writeVaultFile(vault, "..\\outside\\evil.md", "PWNED");
  check("backslash '..' write rejected", bs.ok === false && bs.reason === "traversal");
  const abs = await writeVaultFile(vault, path.join(outside, "abs-evil.md"), "PWNED");
  check("absolute-path write rejected", abs.ok === false && abs.reason === "traversal");
  const delEsc = await deleteVaultFile(vault, "../outside/secret.md");
  check("'../' delete rejected", delEsc.ok === false && delEsc.reason === "traversal");
  check("nothing written/removed outside the vault", JSON.stringify(fs.readdirSync(outside).sort()) === outsideBefore);
  check("outside secret untouched", fs.readFileSync(path.join(outside, "secret.md"), "utf8").includes("TOP SECRET"));

  // 6. COMMIT verification — the writer's ops land in the vault's git history.
  const log = git("log", "--pretty=%s");
  check("history shows the UI write", log.includes("loom: write notes/hello.md (via UI)"));
  check("history shows the UI create", log.includes("loom: create fresh.md (via UI)"));
  check("history shows the UI delete", log.includes("loom: delete fresh.md (via UI)"));

  // 7. the EXISTING auto-commit path is unbroken: the shared commitVault still commits a plain
  //    filesystem change made OUTSIDE the writer (this is exactly what VaultVersioner calls).
  fs.writeFileSync(path.join(vault, "external.md"), "changed outside the writer\n");
  check("shared auto-commit path still commits", (await commitVault(vault, "loom: auto-commit test")) === true);
  check("auto-commit landed in history", git("log", "--pretty=%s").includes("loom: auto-commit test"));
  check("nothing left uncommitted", git("status", "--porcelain").trim() === "");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS — vault writer + guards hold." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
