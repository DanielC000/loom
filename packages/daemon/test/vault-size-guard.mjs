// Unit test for the vault auto-commit oversized-file guard (card 614dfbef, origin finding 4ae8a3c9): a
// vault auto-committed >100MB blobs (two ~2.7GB) via `loom: auto-commit`, permanently wedging its GitHub
// backup. Proves commitVault refuses to commit a file above a configurable threshold, unstages it (rest
// of the staged set still commits), and re-commits fine once the file is no longer oversized/present.
// Uses a tiny opts.maxFileBytes so the test doesn't need a real 95MB fixture. Claude-free, no network.
// Run after build: node test/vault-size-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitVault } from "../dist/vault/versioner.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-vault-size-guard-")));
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();

const MAX_BYTES = 1024; // 1KB threshold for the test — real default is ~95MB

try {
  git("init");
  git("config", "user.email", "loom-test@example.com");
  git("config", "user.name", "loom-test");

  // 1. FIRST-EVER commit (no HEAD yet) with ONE small file + ONE oversized file staged together: the
  // oversized file must be skipped (unstaged, left untracked) while the small file still commits.
  fs.writeFileSync(path.join(root, "small.md"), "# small doc\n");
  fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(MAX_BYTES + 1, 1));
  const committed1 = await commitVault(root, "loom: auto-commit 1", { maxFileBytes: MAX_BYTES });
  check("commit proceeds despite an oversized staged file (pre-first-commit repo)", committed1 === true);
  const log1 = git("log", "--oneline");
  check("exactly one commit made", log1.trim().split("\n").length === 1);
  const tracked1 = git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
  check("small.md WAS committed", tracked1.includes("small.md"));
  check("big.bin was NOT committed", !tracked1.includes("big.bin"));
  check("big.bin still sits on disk, untracked", git("status", "--porcelain").includes("big.bin"));

  // 2. A LATER commit: the still-oversized file is skipped again (repeat offense), a new small file commits.
  fs.writeFileSync(path.join(root, "small2.md"), "# another doc\n");
  const committed2 = await commitVault(root, "loom: auto-commit 2", { maxFileBytes: MAX_BYTES });
  check("second commit proceeds, still skipping the oversized file", committed2 === true);
  const tracked2 = git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
  check("small2.md committed on the second pass", tracked2.includes("small2.md"));
  check("big.bin still not committed on the second pass", !tracked2.includes("big.bin"));

  // 3. Shrinking the file below the threshold lets it commit normally on the next pass.
  fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(10, 1)); // now well under MAX_BYTES
  const committed3 = await commitVault(root, "loom: auto-commit 3", { maxFileBytes: MAX_BYTES });
  check("commit proceeds after the file shrinks below threshold", committed3 === true);
  const tracked3 = git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
  check("big.bin committed once it's no longer oversized", tracked3.includes("big.bin"));

  // 4. An ONLY-oversized commit attempt (nothing else staged) is a clean no-op — false, not a throw.
  fs.writeFileSync(path.join(root, "big2.bin"), Buffer.alloc(MAX_BYTES + 1, 2));
  const committed4 = await commitVault(root, "loom: auto-commit 4 (oversized only)", { maxFileBytes: MAX_BYTES });
  check("an oversized-only staged set commits nothing (false, not a throw)", committed4 === false);
  const tracked4 = git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
  check("big2.bin never entered history", !tracked4.includes("big2.bin"));

  // 5. Default threshold (no opts) never trips on ordinary small files — no regression for the common path.
  fs.writeFileSync(path.join(root, "normal.md"), "# ordinary vault doc\n");
  const committedDefault = await commitVault(root, "loom: auto-commit 5 (default threshold)");
  check("default (~95MB) threshold commits an ordinary small file normally", committedDefault === true);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}

console.log(failures === 0 ? "\nALL PASS — commitVault refuses/skips oversized files, commits the rest." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
