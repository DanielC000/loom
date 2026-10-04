// RED-PROOF FIXTURE ONLY — never imported by production code. Stands in for "the guard removed
// entirely": `acquireStartGuard` here always reports `acquired: true`, exactly as if no guard existed at
// all. Used by start-guard-race.mjs to prove its own race-detection assertions are discriminating — i.e.
// they actually go RED against a module with no mutual exclusion, not just vacuously green against
// anything. Same export shape as the real `bin/lib/start-guard.mjs` so test worker scripts can target
// either module interchangeably via a single module-path argv.
export function acquireStartGuard() {
  return Promise.resolve({ acquired: true, release: () => {} });
}
