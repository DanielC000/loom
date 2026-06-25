/**
 * Card af902717 — compose a WORKER session's opening from its agent BASE BRIEF + the dynamic part.
 *
 * Before this, a manager-spawned worker only ever received the dynamic text (the manager's kickoff on
 * spawn, the `[loom:handoff]…` summary on recycle); its agent's `startupPrompt` (the Dev/Bugfix/Web
 * Designer brief — "Step 0: run `/worker`", "CLAUDE.md is law", reproduce-first) was DEAD config in the
 * orchestrated flow. The manager path already composed its brief (`composeManagerStartupPrompt`); this
 * is the worker mirror.
 *
 * Order: the agent BASE BRIEF FIRST, then the dynamic part (kickoff / handoff) — the brief is the
 * standing doctrine, the dynamic part is the specific task to act on. An empty/whitespace brief ⇒ return
 * the dynamic part ALONE (today's behavior, preserved byte-for-byte — e.g. the QA agent ships
 * `startupPrompt:""`). PURE + exported so the hermetic test can assert the composition.
 */
export function composeWorkerStartupPrompt(
  brief: string | undefined,
  dynamicPart: string,
): string {
  const base = brief?.trim();
  return base ? `${base}\n\n---\n\n${dynamicPart}` : dynamicPart;
}
