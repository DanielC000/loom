// Card e26f3199 fixture: exits 0 almost immediately, but first spawns _late-close-grandchild.mjs with
// `stdio: "inherit"` — the grandchild reuses THIS process's own stdout/stderr file descriptors, which are
// themselves pipes owned by whatever spawned THIS process. Node's 'close' event on that outer spawn only
// fires once every open reference to those pipe fds is closed, so the grandchild holding them open keeps
// 'close' from firing for as long as it runs, even though THIS process (the direct child) is long gone.
// argv[2] is the grandchild's own delay in ms.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const grandchildDelayMs = process.argv[2] || "1500";

spawn(process.execPath, [path.join(__dirname, "_late-close-grandchild.mjs"), grandchildDelayMs], {
  detached: true,
  stdio: "inherit",
}).unref();

console.log("parent done");
process.exit(0);
