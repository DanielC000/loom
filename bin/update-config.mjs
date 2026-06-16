// Release-channel persistence + npm dist-tag resolution for `loom update` (Releases v1 Part 3).
//
// Loom ships as the npm package `loomctl` (bin `loom`). An update is a plain global reinstall of that
// package at a channel's dist-tag — `stable` → npm's conventional `latest`, `beta` → `beta`. The chosen
// channel is persisted in a tiny JSON file under LOOM_HOME so a bare `loom update` reuses the last
// channel; `--channel X` switches + persists X. (Publishing `beta` dist-tags is an OWNER action — the
// beta channel is inert until those tags exist; the mechanism is built regardless.)
//
// PURE + side-effect-free on import (only defines functions; every fs touch is inside a call and takes
// an explicit LOOM_HOME dir), so it is unit-testable in isolation against a throwaway temp home.
import path from "node:path";
import fs from "node:fs";

export const CHANNELS = ["stable", "beta"];
export const DEFAULT_CHANNEL = "stable";
export const DEFAULT_PACKAGE = "loomctl"; // the published npm package name (bin is `loom`)

// stable → npm's conventional "latest" dist-tag; beta → "beta".
const DIST_TAGS = { stable: "latest", beta: "beta" };

export function isValidChannel(c) { return CHANNELS.includes(c); }

// The npm dist-tag for a channel ("latest" / "beta"). Throws on an unknown channel (callers validate
// the channel up front, so a throw here means a programmer error, not bad user input).
export function distTagFor(channel) {
  const tag = DIST_TAGS[channel];
  if (!tag) throw new Error(`unknown channel '${channel}' (expected ${CHANNELS.join(" | ")})`);
  return tag;
}

// The full npm install spec for a channel, e.g. "loomctl@latest" / "loomctl@beta".
export function installSpecFor(channel, pkg = DEFAULT_PACKAGE) {
  return `${pkg}@${distTagFor(channel)}`;
}

export function channelConfigPath(loomHome) { return path.join(loomHome, "update-config.json"); }

// Read the persisted channel; DEFAULT_CHANNEL when the file is missing/malformed or holds a bad value.
export function readChannel(loomHome) {
  try {
    const rec = JSON.parse(fs.readFileSync(channelConfigPath(loomHome), "utf8"));
    if (rec && isValidChannel(rec.channel)) return rec.channel;
  } catch { /* missing or malformed → fall through to the default */ }
  return DEFAULT_CHANNEL;
}

// Persist the channel (creating LOOM_HOME if needed). Returns the written channel. Throws on a bad
// channel so a caller can't silently persist garbage (the CLI validates via parseArgs before calling).
export function writeChannel(loomHome, channel) {
  if (!isValidChannel(channel)) throw new Error(`invalid channel '${channel}' (expected ${CHANNELS.join(" | ")})`);
  fs.mkdirSync(loomHome, { recursive: true });
  fs.writeFileSync(channelConfigPath(loomHome), JSON.stringify({ channel }, null, 2) + "\n");
  return channel;
}
