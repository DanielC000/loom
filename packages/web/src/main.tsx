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
//
// @decision ad42a127 — this handler is the ONLY place that may alert a mutation failure; an alerting
// call-site `onError` shows a SECOND modal for the same failure (v5 runs both), and a mutation that
// renders inline without `meta.inlineError` gives the user an inline message AND a modal.
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

// Anchor for packages/daemon/test/web-build-no-orphans.mjs (card db36d7a4): that test mutates ONLY the
// string literal below to produce two real builds with distinct, verifiable content hashes while it
// exercises turbo's build cache. It used to anchor on the mutation-failure alert's own error-message
// expression above, which broke (commit 53b81688) the first time that unrelated code was refactored.
// Keeping this anchor on its own line, decoupled from real app logic, is what makes it refactor-proof —
// don't fold it into the handler above, and don't remove the assignment: it's a deliberate side effect so
// bundlers never tree-shake it out of the production bundle (a dropped assignment would make two
// "different" builds byte-identical, silently defeating the test's whole purpose).
(window as unknown as { __loomBuildVerify?: string }).__loomBuildVerify = "anchor-base";

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
