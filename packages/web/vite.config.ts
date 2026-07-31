import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Mirrors packages/daemon/src/paths.ts:206 (`PORT = Number(process.env.LOOM_PORT || 4317)`) — replicated
// by hand rather than imported (web is a separate bundler-resolution package; paths.ts is daemon-internal).
// Keep the `||` fallback semantics identical to that resolver if it ever changes, so a bare
// `LOOM_PORT=""` (or "0") behaves the same here as it does for the daemon itself.
const DAEMON_PORT = Number(process.env.LOOM_PORT || 4317);
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;

// Surface the resolved proxy target on dev-server start so a LOOM_PORT mismatch (e.g. reviewing an
// isolated throwaway daemon while still proxied to the default one) is visible, not silent.
const logProxyTarget: Plugin = {
  name: "log-proxy-target",
  configureServer() {
    console.log(`[web] proxying → ${DAEMON}`);
  },
};

// Web is a stateless viewport; the daemon owns sessions. Dev-proxy REST + ws to the daemon.
export default defineConfig({
  plugins: [react(), logProxyTarget],
  build: {
    // Emit dist/.vite/manifest.json: the authoritative list of every file THIS build intended to
    // produce (every entry's chunk + its transitive dynamic-import chunks + css + assets) — used by
    // scripts/build-npm-package.mjs's orphan guard so it doesn't have to (fragilely) regex-scrape
    // index.html for asset references, which would misfire the moment code-splitting introduces a
    // chunk that's only ever reached via a dynamic import() and never named in index.html itself.
    manifest: true,
  },
  server: {
    port: 5317,
    proxy: {
      "/api": { target: DAEMON, changeOrigin: true },
      // /internal/update (Epic 2c-2 self-update trigger) is loopback-gated on the daemon; proxy it so the
      // banner's button reaches it in dev too. (In single-process prod the UI is same-origin — no proxy.)
      "/internal": { target: DAEMON, changeOrigin: true },
      "/ws": { target: DAEMON, ws: true },
    },
  },
});
