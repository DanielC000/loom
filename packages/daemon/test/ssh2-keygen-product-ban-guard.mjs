import "./_guard.mjs"; // prod-guard: pure fs source-text scan — no daemon/Db used below
// STANDING GUARD (card 6c77ec05): product code (packages/daemon/src/**) must never call ssh2's key GENERATOR
// (`utils.generateKeyPairSync` / `generateKeyPair`).
//
// WHY: ssh2@1.17.0's ed25519 generator emits a malformed private key about 1 time in 256 (lib/keygen.js
// strips the real public key's leading 0x00 together with the ASN.1 unused-bits byte; see card 28c304b2 and
// test/_ssh-test-keys.mjs). Product code does not call it today — connections/ssh.ts and connections/sshKey.ts
// only PARSE keys the owner submits. Patching node_modules would not reach npm end users, so the defence is
// to keep the generator out of src. A future key-generation feature must use Node's
// `crypto.generateKeyPairSync('ed25519')` plus Loom's own OpenSSH serialization, or ssh2 plus
// parse-verify-and-retry — never the bare ssh2 generator (decision record a3d5c7f4).
//
// WHAT IT CHECKS (source-TEXT scan of src/**, comments stripped; not a data-flow analysis): every occurrence
// of the token `generateKeyPair` / `generateKeyPairSync` is a violation UNLESS it is Node's own crypto: a
// member access whose receiver is a binding of `node:crypto`/`crypto` (default, namespace or require), or a
// token that sits inside a `node:crypto` import clause. Being token-based it catches an aliased import
// (`import { generateKeyPairSync as g } from "ssh2"`), `utils.` member access, destructuring
// (`const { generateKeyPairSync } = utils`) and a quoted computed key (`utils["generateKeyPairSync"]`),
// and it does not depend on which file imported ssh2 (so a re-export wrapper is covered too).
// NOT COVERED: a key name assembled at runtime (`utils["generate" + "KeyPair"]`), and a destructure of
// the generator out of a crypto binding (`const { generateKeyPairSync } = crypto`) is a false POSITIVE —
// write `crypto.generateKeyPairSync(...)` instead.
//
// NOT in STATIC_GUARD_REPO_PATHS (worktrees.ts), deliberately — the membership criterion there admits a
// guard only if something OTHER than a behavioural `.ts` edit can invalidate it. This guard's only
// invalidator is a new call in `packages/daemon/src/**`, which is a behavioural `.ts` edit that already forces
// the FULL gate, where this file runs via the corpus walk. The one gap is an interval-UNGATED landing (no gate
// at all), so CLAUDE.md's ungated-landing bullet names this file for the safety-net command.
//
// Run: node packages/daemon/test/ssh2-keygen-product-ban-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "..", "src");

/** Blank out comments (and keep string/template literals intact), preserving newlines for line numbers. */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { out += src[i++]; }
        out += src[i++];
      }
      out += q;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** @returns {{line:number, text:string}[]} violations in one source string. */
export function findSsh2KeygenCalls(source) {
  let code = stripComments(source);
  const cryptoNs = new Set(["crypto"]);
  const CRYPTO = String.raw`["'](?:node:)?crypto["']`;
  // Blank out node:crypto import clauses (tokens inside them are Node's own) and record namespace bindings.
  const blank = (m) => m.replace(/[^\n]/g, " ");
  code = code.replace(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*${CRYPTO}`, "g"), (m, id) => { cryptoNs.add(id); return blank(m); });
  code = code.replace(new RegExp(String.raw`import\s*\{[^}]*\}\s*from\s*${CRYPTO}`, "g"), blank);
  code = code.replace(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\(\s*${CRYPTO}\s*\)`, "g"), (m, id) => { cryptoNs.add(id); return m; });
  code = code.replace(new RegExp(String.raw`(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:await\s+)?(?:require|import)\(\s*${CRYPTO}\s*\)`, "g"), blank);

  const hits = [];
  const re = /\bgenerateKeyPair(?:Sync)?\b/g;
  let m;
  while ((m = re.exec(code))) {
    const before = code.slice(0, m.index);
    const recv = /([A-Za-z_$][\w$]*)\s*\??\.\s*$/.exec(before);
    if (recv && cryptoNs.has(recv[1])) continue;
    const line = before.split("\n").length;
    hits.push({ line, text: code.split("\n")[line - 1].trim() });
  }
  return hits;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---- (A) controls: the detector must go RED on every ssh2 shape and stay GREEN on Node's crypto ----
const RED = {
  "default import + utils member": 'import ssh2 from "ssh2";\nconst k = ssh2.utils.generateKeyPairSync("ed25519");',
  "named utils import": 'import { utils } from "ssh2";\nutils.generateKeyPairSync("ed25519");',
  "aliased named import": 'import { generateKeyPairSync as g } from "ssh2";\ng("ed25519");',
  "destructured from utils": 'import ssh2 from "ssh2";\nconst { generateKeyPair } = ssh2.utils;\ngenerateKeyPair("rsa", {}, cb);',
  "async generateKeyPair member": 'const s = require("ssh2");\ns.utils.generateKeyPair("ed25519", {}, cb);',
  "dynamic import": 'const k = (await import("ssh2")).default.utils.generateKeyPairSync("ed25519");',
  "quoted computed key": 'import ssh2 from "ssh2";\nssh2.utils["generateKeyPairSync"]("ed25519");',
  "crypto imported but ssh2 call in the same file": 'import crypto from "node:crypto";\nimport ssh2 from "ssh2";\ncrypto.generateKeyPairSync("ed25519");\nssh2.utils.generateKeyPairSync("ed25519");',
};
for (const [name, src] of Object.entries(RED)) {
  check(`control RED: ${name}`, findSsh2KeygenCalls(src).length >= 1);
}
const GREEN = {
  "node:crypto default import": 'import crypto from "node:crypto";\ncrypto.generateKeyPairSync("ed25519");',
  "crypto namespace import": 'import * as nodeCrypto from "crypto";\nnodeCrypto.generateKeyPairSync("ed25519");',
  "crypto named import (aliased)": 'import { generateKeyPairSync as gk } from "node:crypto";\ngk("ed25519");',
  "require crypto": 'const c = require("node:crypto");\nc.generateKeyPair("ed25519", {}, cb);',
  "ssh2 file with no generator call": 'import ssh2 from "ssh2";\nssh2.utils.parseKey(k);',
  "generator named only in a comment": '// never call ssh2 generateKeyPairSync here\n/* utils.generateKeyPair */\nimport ssh2 from "ssh2";',
};
for (const [name, src] of Object.entries(GREEN)) {
  const hits = findSsh2KeygenCalls(src);
  check(`control GREEN: ${name}`, hits.length === 0, JSON.stringify(hits));
}

// ---- (B) the real corpus: packages/daemon/src/** ----
const files = walk(SRC_DIR);
check("corpus is non-empty and includes the ssh files (the scan can see the code it guards)",
  files.length > 100 && files.some((f) => f.endsWith(path.join("connections", "ssh.ts"))) && files.some((f) => f.endsWith(path.join("connections", "sshKey.ts"))),
  `files=${files.length}`);
const offenders = [];
for (const f of files) {
  for (const h of findSsh2KeygenCalls(fs.readFileSync(f, "utf8"))) offenders.push(`${path.relative(SRC_DIR, f)}:${h.line}  ${h.text}`);
}
check("no product source calls ssh2's key generator", offenders.length === 0,
  `ssh2@1.17.0's generateKeyPairSync("ed25519") emits a malformed key ~1 in 256 (card 28c304b2), and patching node_modules would not reach npm users. ` +
  `Use node:crypto generateKeyPairSync('ed25519') plus Loom's own OpenSSH serialization, or ssh2 plus parse-verify-and-retry. Offenders:\n  ${offenders.join("\n  ")}`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall ssh2 keygen product-ban checks passed");
