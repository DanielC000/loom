import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The default risky list for a NEW ssh connection holds the file-overwriting verbs `tee`, `truncate`, `shred`
// and `sed` in-place (owner decision e7401fff) — and ONLY a new connection gets it: an existing row keeps the
// list it was saved with. Each verb is HELD on the flat (OFF) path AND in shell mode; cp/mv/`sed -n 1p f`/
// `sed s/a/b/ f`/cat stay clean on the OFF path. Run: build first, then node test/ssh-risky-default-overwrite-verbs.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lsd-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { evaluateSshCommandPolicy } = await import("../dist/connections/sshPolicy.js");
const { DEFAULT_SSH_RISKY_COMMAND_PATTERNS } = await import("@loom/shared");
const { Db } = await import("../dist/db.js");
const { createSshConnection, getConnectionMetadata, validateSshConnectionInput } = await import("../dist/connections/store.js");
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");
const sshUtils = (await import("ssh2")).default.utils;

try {
  // A NEW connection: the store seeds the shipped default, which must contain the new rules.
  const seeded = validateSshConnectionInput({ name: "n", host: "h", user: "u", privateKey: "k", hostKeyFingerprint: "SHA256:" + "A".repeat(43) });
  check("new connection: store seeds the shipped default (carries the four new verbs)",
    seeded.ok === true && JSON.stringify(seeded.riskyCommandPatterns) === JSON.stringify(DEFAULT_SSH_RISKY_COMMAND_PATTERNS)
    && ["tee", "truncate", "shred"].every((p) => seeded.riskyCommandPatterns.some((r) => r.kind === "prefix" && r.pattern === p))
    && seeded.riskyCommandPatterns.some((r) => r.kind === "regex" && r.pattern.includes("--")));
  check("default does NOT name cp or mv", !DEFAULT_SSH_RISKY_COMMAND_PATTERNS.some((r) => /^(cp|mv)\b/.test(r.pattern)));

  const off = { id: "c-off", readOnly: false, commandAllowlist: [], riskyCommandPatterns: [...DEFAULT_SSH_RISKY_COMMAND_PATTERNS] };
  const shell = { ...off, id: "c-shell", shellSyntax: true };
  const held = async (conn, cmd) => { const v = await evaluateSshCommandPolicy(conn, cmd); return v.allowed === true && v.requiresApproval === true; };
  const clean = async (conn, cmd) => { const v = await evaluateSshCommandPolicy(conn, cmd); return v.allowed === true && v.requiresApproval !== true; };

  const HELD = [
    "tee /etc/fstab", "tee -a /tmp/x", "sudo tee /etc/fstab", "/usr/bin/tee x",
    "truncate -s0 x", "truncate -s 0 /var/log/x", "sudo truncate -s0 x",
    "shred x", "shred -u x", "/usr/bin/shred -n 3 x",
    "sed -i s/a/b/ f", "sed -i.bak s/a/b/ f", "sed --in-place s/a/b/ f", "sed --in-place=.bak s/a/b/ f", "sed --in s/a/b/ f",
    "sed -ni 1p f", "sed -n -i 1p f", "sed -ie s/a/b/ f", "sed -E -i s/a/b/ f", "sed s/a/b/ f -i", "sudo sed -i s/a/b/ f", "/bin/sed -i s/a/b/ f", "SED -i s/a/b/ f",
  ];
  for (const cmd of HELD) {
    check(`OFF: ${JSON.stringify(cmd)} is HELD`, await held(off, cmd));
    // Shell mode accepts only closed-grammar commands; each of these is plain words, so it is parsed and still must hold.
    check(`shell mode: ${JSON.stringify(cmd)} is HELD`, await held(shell, cmd));
  }
  const CLEAN = ["sed -n 1p f", "sed s/a/b/ f", "sed -ne 1p f", "sed -E s/a/b/ f", "sed --quiet 1p f", "sed -e 1p -n f", "cat f", "cp a b", "mv a b", "ls /tmp", "grep teeth f"];
  for (const cmd of CLEAN) {
    // `grep teeth f` is a deliberate pinned over-match of the bare `tee` prefix rule (a word screen over-matches by design).
    if (cmd === "grep teeth f") { check(`(pinned over-match) ${JSON.stringify(cmd)} is held by the bare 'tee' prefix`, await held(off, cmd)); continue; }
    check(`OFF control: ${JSON.stringify(cmd)} is NOT held`, await clean(off, cmd));
  }
  check("shell mode control: cat f / cp a b / mv a b are NOT held", await clean(shell, "cat f") && await clean(shell, "cp a b") && await clean(shell, "mv a b"));

  // An EXISTING row keeps its stored list: create with an explicit older-shape list, reopen the db, read back.
  const OLD = [{ kind: "prefix", pattern: "rm " }, { kind: "prefix", pattern: "reboot" }];
  const key = generateParseableEd25519(sshUtils).private;
  const dbFile = path.join(tmpHome, "existing.db");
  let id;
  { const db = new Db(dbFile); id = createSshConnection(db, { name: "old", host: "h", user: "u", privateKey: key, hostKeyFingerprint: "SHA256:" + "A".repeat(43), riskyCommandPatterns: OLD }).id; db.close(); }
  const db2 = new Db(dbFile);
  const meta = getConnectionMetadata(db2, id);
  db2.close();
  check("existing row: stored list survives a reopen unchanged (no new verb injected)", JSON.stringify(meta?.riskyCommandPatterns) === JSON.stringify(OLD));
  check("existing row: `tee x` / `shred x` / `sed -i s/a/b/ f` are NOT held under its stored list",
    await clean({ ...off, riskyCommandPatterns: meta.riskyCommandPatterns }, "tee x") && await clean({ ...off, riskyCommandPatterns: meta.riskyCommandPatterns }, "shred x")
    && await clean({ ...off, riskyCommandPatterns: meta.riskyCommandPatterns }, "sed -i s/a/b/ f"));

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
} finally {
  cleanupPathSync(tmpHome);
}
process.exit(failures === 0 ? 0 : 1);
