import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DAEMON = "http://127.0.0.1:4317";

// Web is a stateless viewport; the daemon owns sessions. Dev-proxy REST + ws to the daemon.
export default defineConfig({
  plugins: [react()],
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
