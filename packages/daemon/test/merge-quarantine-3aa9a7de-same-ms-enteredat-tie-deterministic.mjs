import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Pins the same-millisecond enteredAt tie rule of unionQuarantineEntries: the FIRST argument (the
// standing/accumulated entry) wins, in BOTH argument orders, and tokens of both sides still union.
// Entries carry an explicit equal enteredAt, so no clock is involved and the tie is forced.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq3aa9-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const T = 1_700_000_000_000;
const mk = (repoPath, branch, token) => ({ repoPath, branch, reason: "r", opId: `op-${branch}`, enteredAt: T, tokens: [token] });
const x = mk("/repo/x", "loom/aaa", "tok-x");
const y = mk("/repo/x", "loom/bbb", "tok-y");

const xy = mod.unionQuarantineEntriesTestOnly(x, y);
const yx = mod.unionQuarantineEntriesTestOnly(y, x);
check("tie: first argument's identity wins (x first)", xy.branch === "loom/aaa" && xy.opId === "op-loom/aaa");
check("tie: first argument's identity wins (y first)", yx.branch === "loom/bbb" && yx.opId === "op-loom/bbb");
check("tie: tokens of both sides survive in both orders", [xy, yx].every((u) => u.tokens.length === 2 && u.tokens.includes("tok-x") && u.tokens.includes("tok-y")));

// A strictly earlier enteredAt wins regardless of argument order (tie rule must not leak into non-ties).
const early = { ...y, enteredAt: T - 1 };
check("non-tie: earlier wins (a first)", mod.unionQuarantineEntriesTestOnly(early, x).branch === "loom/bbb");
check("non-tie: earlier wins (b first)", mod.unionQuarantineEntriesTestOnly(x, early).branch === "loom/bbb");
const late = { ...y, enteredAt: T + 1 };
check("non-tie: later loses even as first argument", mod.unionQuarantineEntriesTestOnly(late, x).branch === "loom/aaa");

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
