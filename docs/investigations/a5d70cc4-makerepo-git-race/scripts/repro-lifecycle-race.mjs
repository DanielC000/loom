// Launches N concurrent OS processes, each running repro-child-lifecycle.mjs for `rounds`
// full repo+worktree lifecycles, and collects every reported failure across all of them.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, "repro-child-lifecycle.mjs");

const N = Number(process.argv[2] || "10");
const rounds = Number(process.argv[3] || "5");

function runChild(workerId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, String(workerId), String(rounds)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const lines = out.split("\n").filter(Boolean);
      const fails = [];
      let done = false;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.done) done = true;
          else if (obj.ok === false) fails.push(obj);
        } catch {}
      }
      resolve({ workerId, exitCode: code, done, fails });
    });
  });
}

async function main() {
  console.log(`N=${N} rounds=${rounds} (each round = init+commit + 2x worktree-add+commit)`);
  const start = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => runChild(i)));
  const allFails = results.flatMap((r) => r.fails);
  const totalOps = N * rounds * 5; // init+commit chain, 2x(worktree-add + commit chain)
  console.log(`elapsed=${Date.now() - start}ms totalOpGroups~=${totalOps} failures=${allFails.length}`);
  for (const f of allFails) {
    console.log("FAIL", JSON.stringify(f, null, 2));
  }
  for (const r of results) {
    if (!r.done) console.log(`WARN worker ${r.workerId} never reported done (exitCode=${r.exitCode})`);
  }
  process.exitCode = allFails.length > 0 ? 1 : 0;
}

main();
