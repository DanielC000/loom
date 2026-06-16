import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// `loom update [--channel stable|beta]` — channel parsing (bin/loom.mjs › parseArgs) + channel
// persistence / dist-tag resolution (bin/update-config.mjs). HERMETIC + side-effect-free: importing
// either bin only defines functions (the CLI dispatch runs ONLY under the bin's invokedDirectly guard),
// and the config helpers are exercised against a THROWAWAY temp home — never the dev ~/.loom. Proves:
//   - `loom update` parses to the update command with channel null (→ reuse the persisted channel);
//   - --channel/--channel= (both spellings) map a valid channel; an invalid one is a 2-exit error;
//   - stable → loomctl@latest, beta → loomctl@beta (npm dist-tag mapping);
//   - readChannel defaults to stable when unset/malformed; writeChannel persists + readChannel reads it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs");           // → repo root
const CFG = path.join(__dirname, "..", "..", "..", "bin", "update-config.mjs");
const { parseArgs } = await import(pathToFileURL(BIN).href);
const { CHANNELS, DEFAULT_CHANNEL, isValidChannel, distTagFor, installSpecFor, readChannel, writeChannel, channelConfigPath } =
  await import(pathToFileURL(CFG).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// (1) `loom update` parses to the update command; bare update leaves channel null (reuse persisted).
{
  const r = parseArgs(["update"]);
  check("update: command 'update'", r.command === "update" && r.error === null);
  check("update: channel null when not supplied", r.channel === null);
}

// (2) --channel (both spellings) maps a valid channel.
check("update --channel beta", parseArgs(["update", "--channel", "beta"]).channel === "beta");
check("update --channel=stable", parseArgs(["update", "--channel=stable"]).channel === "stable");

// (3) an invalid / missing channel value is a 2-exit error.
check("update --channel bogus → error exit 2", (() => { const r = parseArgs(["update", "--channel", "bogus"]); return r.error !== null && r.exitCode === 2; })());
check("update --channel= (empty) → error exit 2", (() => { const r = parseArgs(["update", "--channel="]); return r.error !== null && r.exitCode === 2; })());

// (4) dist-tag mapping + install spec construction.
check("stable → latest", distTagFor("stable") === "latest");
check("beta → beta", distTagFor("beta") === "beta");
check("installSpec stable = loomctl@latest", installSpecFor("stable") === "loomctl@latest");
check("installSpec beta = loomctl@beta", installSpecFor("beta") === "loomctl@beta");
check("isValidChannel guards", isValidChannel("stable") && isValidChannel("beta") && !isValidChannel("dev") && !isValidChannel(""));
check("channels + default", CHANNELS.length === 2 && DEFAULT_CHANNEL === "stable");

// (5) persistence round-trip against a throwaway temp home.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loom-chan-"));
  try {
    check("readChannel defaults to stable when unset", readChannel(home) === "stable");
    check("writeChannel(beta) returns beta", writeChannel(home, "beta") === "beta");
    check("config file written under home", fs.existsSync(channelConfigPath(home)));
    check("readChannel reads persisted beta", readChannel(home) === "beta");
    check("switch back to stable persists", writeChannel(home, "stable") === "stable" && readChannel(home) === "stable");
    // malformed file → default (not a throw).
    fs.writeFileSync(channelConfigPath(home), "{ not json");
    check("malformed config → default stable", readChannel(home) === "stable");
    // writeChannel rejects a bad channel rather than persisting garbage.
    let threw = false;
    try { writeChannel(home, "dev"); } catch { threw = true; }
    check("writeChannel rejects bad channel", threw);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `loom update` parses + validates --channel; channel persists/reads under LOOM_HOME; dist-tags map (stable→latest, beta→beta)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
