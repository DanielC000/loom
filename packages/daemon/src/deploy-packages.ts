/**
 * Card c3ce92ea — single source of truth for which workspace packages a daemon deploy rebuilds, and
 * whether a change to each requires a daemon PROCESS restart to take effect or only a rebuild.
 * `orchestration/restart.ts`'s deploy build step and `deploy-staleness.ts`'s staleness signal both derive
 * their package/pathspec lists from this one array, so they cannot silently diverge again the way they
 * did before this card: `restart.ts` already rebuilt `@loom/web` on every deploy (its own comment said
 * why — the daemon serves `packages/web/dist` statically), but `deploy-staleness.ts` never read
 * `packages/web/src` at all, so a web-only merge reported `stale:false` while the served bundle was
 * genuinely stale.
 */
export interface DeployPackage {
  /** turbo/pnpm workspace name, passed to the deploy build as `--filter=<name>`. */
  name: string;
  /** git pathspec for this package's source, used to detect commits not yet reflected in its build output. */
  srcPathspec: string;
  /**
   * Whether a change under `srcPathspec` requires restarting the daemon PROCESS (not just rebuilding
   * its output) to take effect. true for `@loom/daemon`/`@loom/shared`: their compiled `dist/` is only
   * ever read by the currently-running node process at import time. false for `@loom/web`: the daemon
   * serves `packages/web/dist` LIVE FROM DISK on every request (`@fastify/static`'s `root`, registered
   * in `gateway/server.ts`) — a rebuilt file is served on the very next request, no restart needed.
   */
  restartRequired: boolean;
}

export const DEPLOY_PACKAGES: DeployPackage[] = [
  { name: "@loom/daemon", srcPathspec: "packages/daemon/src", restartRequired: true },
  { name: "@loom/shared", srcPathspec: "packages/shared/src", restartRequired: true },
  { name: "@loom/web", srcPathspec: "packages/web/src", restartRequired: false },
];
