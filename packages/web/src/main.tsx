import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";

// Surface mutation failures instead of swallowing them — resume/stop/fork/input used to fail
// silently (a dead-looking button). One global handler covers every mutation; no per-call onError.
const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (err) => {
      // eslint-disable-next-line no-console
      console.error("[action failed]", err);
      window.alert(`Action failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  }),
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
