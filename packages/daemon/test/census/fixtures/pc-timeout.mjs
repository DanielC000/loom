// Phase 0 positive-control fixture: hangs well past any short timeout override the driver passes it,
// to prove the harness's kill-and-report-timeout path fires (known-bad, the timeout variant).
await new Promise((resolve) => setTimeout(resolve, 10_000));
