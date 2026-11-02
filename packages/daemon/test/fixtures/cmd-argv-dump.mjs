// Dumps its OWN received argv (JSON array, everything after the script path) to the file given as the
// FIRST argument. Used by env-isolated-launch.mjs's cmd.exe-metacharacter-escaping test (card fafae623
// CR round 1) to prove an argument crossing cmd.exe's /c tokenizer arrives byte-for-byte intact.
import fs from "node:fs";
const [outFile, ...rest] = process.argv.slice(2);
fs.writeFileSync(outFile, JSON.stringify(rest));
