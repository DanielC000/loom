import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { FleetSocketProvider } from "./components/FleetSocketProvider";
import { isCredentialGuardMessage } from "./lib/loopbackCredential";

// Surface mutation failures instead of swallowing them — resume/stop/fork/input used to fail
// silently (a dead-looking button). One global handler covers every mutation; no per-call onError.
// A mutation that renders its own inline error opts out of the blocking alert via `meta.inlineError`
// (avoids a redundant + automation-wedging modal — e.g. Settings save).
const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      // eslint-disable-next-line no-console
      console.error("[action failed]", err);
      if (mutation.meta?.inlineError) return;
      const message = err instanceof Error ? err.message : String(err);
      // Card 093981dd: the credential-guard 401 has its own persistent banner, which says more than this
      // modal can and doesn't block. Alerting too would mean one modal per failed write on a page that
      // fires several — and the daemon's text ("see `loom open`") is wrong for the tunnelled browser this
      // most often hits. CredentialBanner is armed by lib/api's guardedFetch before this runs.
      if (isCredentialGuardMessage(message)) return;
      window.alert(`Action failed: ${message}`);
    },
  }),
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <FleetSocketProvider />
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
