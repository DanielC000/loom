import fs from "node:fs";
import path from "node:path";
import { loomVersion, isPackagedInstall } from "../version.js";

/**
 * Epic 2c-2 (UI half of the update story) — the daemon-side npm-registry "update available" check.
 *
 * A periodic, best-effort poll of the npm registry dist-tags for `loomctl` on the persisted release
 * channel. When the installed version is BEHIND the channel's dist-tag, that is surfaced read-only via
 * GET /api/update-status, and the web shows an unobtrusive banner. GATED to PACKAGED installs (see
 * version.ts › isPackagedInstall): a from-source daemon never hits the registry and always reports
 * `packaged:false` (banner hidden, update endpoint refuses).
 *
 * The channel + dist-tag + package mirror the CLI half (bin/update-config.mjs — the SOURCE OF TRUTH for
 * the on-disk `update-config.json` format). Re-stated here (not imported) so the daemon stays a
 * self-contained TS module rather than reaching across into the .mjs CLI; both read the SAME file.
 */

export type Channel = "stable" | "beta";
const CHANNELS: readonly Channel[] = ["stable", "beta"];
const DEFAULT_CHANNEL: Channel = "stable";
/** stable → npm's conventional "latest" dist-tag; beta → "beta" (mirror of update-config.mjs's DIST_TAGS). */
const DIST_TAGS: Record<Channel, string> = { stable: "latest", beta: "beta" };
/** The published npm package name (bin is `loom`). */
export const PACKAGE = "loomctl";

/** Default poll cadence — 6h. The registry rarely changes and a behind-by check is not time-critical;
 *  `LOOM_UPDATE_CHECK_INTERVAL_MS` tunes it (a test drives tick() directly, so it never waits). */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
/** Bound the registry fetch so a hung/slow registry can never wedge the watcher tick. */
const FETCH_TIMEOUT_MS = 8000;

/** The read-only status the gateway serves and the web reads. `packaged:false` ⇒ banner never shows. */
export interface UpdateStatus {
  /** A packaged npm install? false on a from-source/dev daemon → the web hides the banner entirely. */
  packaged: boolean;
  /** The persisted release channel (re-read each tick — the CLI may switch it). */
  channel: Channel;
  /** The currently-running version (loomVersion()). */
  installed: string;
  /** The registry dist-tag version for the channel; null until a successful check (or when unavailable). */
  latest: string | null;
  /** packaged AND a parseable `latest` strictly newer than `installed`. */
  updateAvailable: boolean;
  /** ISO timestamp of the last SUCCESSFUL registry check; null if never checked (incl. a source daemon). */
  checkedAt: string | null;
}

/** Read the persisted channel from `<loomHome>/update-config.json`; DEFAULT_CHANNEL when missing/bad
 *  (same tolerance as update-config.mjs › readChannel). */
export function readUpdateChannel(loomHome: string): Channel {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(loomHome, "update-config.json"), "utf8")) as { channel?: string };
    if (rec && CHANNELS.includes(rec.channel as Channel)) return rec.channel as Channel;
  } catch { /* missing or malformed → fall through to the default */ }
  return DEFAULT_CHANNEL;
}

// --- semver-lite comparison (no `semver` dep) -------------------------------------------------------
// Enough to answer "is the registry version strictly newer than the installed one" for x.y.z + an
// OPTIONAL prerelease (the beta channel ships e.g. 0.3.0-beta.1). Unparseable input → never "newer"
// (fail-safe: we must not raise a false banner on a version string we don't understand).

interface SemVer { core: [number, number, number]; pre: string[]; }

function parseVersion(v: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Standard semver precedence: compare core, then prerelease (a version WITHOUT a prerelease outranks one
 *  WITH; identifiers compared numerically when both numeric, else lexically; more identifiers wins ties). */
function compare(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) {
    const ac = a.core[i]!, bc = b.core[i]!;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;  // 1.0.0 > 1.0.0-beta
  if (b.pre.length === 0) return -1;
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const ai = a.pre[i]!, bi = b.pre[i]!;
    const an = /^\d+$/.test(ai), bn = /^\d+$/.test(bi);
    if (an && bn) { const d = Number(ai) - Number(bi); if (d !== 0) return d < 0 ? -1 : 1; }
    else if (an !== bn) return an ? -1 : 1; // numeric identifiers are lower-precedence than alphanumeric
    else if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1;
}

/** True iff `candidate` is a strictly newer version than `current`. Unparseable either side → false. */
export function isNewer(candidate: string, current: string): boolean {
  const c = parseVersion(candidate), i = parseVersion(current);
  if (!c || !i) return false;
  return compare(c, i) > 0;
}

// --- registry fetch ---------------------------------------------------------------------------------

/** Fetch the npm dist-tags map ({ latest: "x", beta: "y" }) for a package. Bounded by an AbortController
 *  so a hung registry can't stall the tick. `LOOM_NPM_REGISTRY` overrides the registry base (default
 *  npmjs). Throws on a non-2xx / network / timeout — the caller treats any throw as "unavailable". */
async function fetchDistTagsLive(pkg: string): Promise<Record<string, string>> {
  const base = (process.env.LOOM_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/-/package/${pkg}/dist-tags`, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    return (await res.json()) as Record<string, string>;
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateCheckDeps {
  /** LOOM_HOME — where update-config.json lives (the persisted channel). */
  loomHome: string;
  /** Installed version; defaults to loomVersion(). Injectable for tests. */
  installed?: () => string;
  /** Packaged-install gate; defaults to isPackagedInstall(). Injectable for tests. */
  isPackaged?: () => boolean;
  /** Registry dist-tags fetch; defaults to the bounded live fetch. Injected with a MOCK in tests (no network). */
  fetchTags?: (pkg: string) => Promise<Record<string, string>>;
  /** Poll cadence; default 6h (LOOM_UPDATE_CHECK_INTERVAL_MS overrides). */
  intervalMs?: number;
}

/**
 * The periodic update-availability watcher. Best-effort + bounded + never-throws (mirrors the other
 * watchers' error handling) so a registry hiccup can never wedge boot or the tick loop. Holds the last
 * computed {@link UpdateStatus} in memory; the gateway serves it read-only via current().
 */
export class UpdateCheckWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: UpdateStatus;
  private readonly installed: () => string;
  private readonly isPackaged: () => boolean;
  private readonly fetchTags: (pkg: string) => Promise<Record<string, string>>;
  private readonly intervalMs: number;

  constructor(private deps: UpdateCheckDeps) {
    this.installed = deps.installed ?? loomVersion;
    this.isPackaged = deps.isPackaged ?? isPackagedInstall;
    this.fetchTags = deps.fetchTags ?? fetchDistTagsLive;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    // Seed an honest pre-check status (latest unknown, nothing claimed behind) so the REST route always
    // has a well-formed object to serve before the first tick lands.
    this.status = {
      packaged: this.isPackaged(),
      channel: readUpdateChannel(deps.loomHome),
      installed: this.installed(),
      latest: null,
      updateAvailable: false,
      checkedAt: null,
    };
  }

  current(): UpdateStatus {
    return this.status;
  }

  /** One check. Re-reads packaged/channel/installed each time (the CLI may switch the channel, and these
   *  are cheap). A source daemon short-circuits with NO network. Never throws — a fetch failure keeps the
   *  previous `latest`/`checkedAt` (we don't blank a known-good result on a transient blip). */
  async tick(): Promise<void> {
    const channel = readUpdateChannel(this.deps.loomHome);
    const installed = this.installed();
    const packaged = this.isPackaged();
    if (!packaged) {
      // From-source/dev daemon: never hit the registry; the banner stays hidden by `packaged:false`.
      this.status = { packaged: false, channel, installed, latest: null, updateAvailable: false, checkedAt: null };
      return;
    }
    try {
      const tags = await this.fetchTags(PACKAGE);
      const latest = tags?.[DIST_TAGS[channel]] ?? null;
      this.status = {
        packaged: true,
        channel,
        installed,
        latest,
        updateAvailable: !!latest && isNewer(latest, installed),
        checkedAt: new Date().toISOString(),
      };
    } catch {
      // Registry unavailable / timed out — keep packaged + channel + installed fresh, preserve any prior
      // latest/checkedAt. Never throw out of a watcher tick.
      this.status = { ...this.status, packaged: true, channel, installed };
    }
  }

  start(): void {
    // Kick one check now (fire-and-forget) so the status populates shortly after boot, then on the interval.
    void this.tick().catch(() => { /* never let the initial check reject unhandled */ });
    this.timer = setInterval(() => { void this.tick().catch(() => { /* swallow — best-effort */ }); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
