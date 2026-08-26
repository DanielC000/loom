// Card 6a9f4178 — dump a single pending_gate_ops row's full outputTail to a .txt file.
// Usage: node dump-op-tail.mjs <opId> <outFile.txt>
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPkgDir = path.join(__dirname, "..", "..", "..", "packages", "daemon");
const require = createRequire(path.join(daemonPkgDir, "package.json"));
const Database = require("better-sqlite3");

const [, , opId, outFile] = process.argv;
const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const db = new Database(path.join(LOOM_HOME, "loom.db"), { readonly: true, fileMustExist: true });
const row = db.prepare("SELECT verdict_payload_json FROM pending_gate_ops WHERE op_id = ?").get(opId);
const p = JSON.parse(row.verdict_payload_json);
fs.writeFileSync(outFile, p.outputTail || "");
console.log(`wrote ${outFile}, outputTail length ${(p.outputTail || "").length}, stderrTail length ${(p.gateDetail?.stderrTail || "").length}`);
db.close();
