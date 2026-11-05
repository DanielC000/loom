import type { Agent } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * Pristine-only refresh of a bundled agent's stored startupPrompt, shared by every seeded prompt.
 *
 * The seeders are seed-if-absent, so editing a prompt constant never reaches an already-seeded row. An
 * agent is PRISTINE only if its stored prompt is byte-identical to a value Loom shipped for it (an entry in
 * that prompt's `*_PRIOR_VALUES`); only a pristine agent moves to the current text, anything else is never
 * touched. Same exact-match test migrateSetupHomeToLead applies to SETUP_ASSISTANT_PROMPT.
 *
 * No app_meta marker, on purpose: each future edit adds a new prior entry, so a once-ever marker would
 * strand every later edit. It is idempotent instead: an agent already on the current text matches nothing.
 */
export interface PristinePromptSpec {
  /** The bundled agent's display name — rows under any other name (a user rename) are skipped. */
  readonly agentName: string;
  /** The CURRENT shipped text. */
  readonly current: string;
  /**
   * Every historical shipped text, byte-exact. When a prompt is edited, its previous text is appended here
   * in the same change. The current text is never needed in this list (it is skipped as a no-op), but
   * listing it before the edit is how it becomes the prior entry.
   */
  readonly priorValues: readonly string[];
}

/** True when `prompt` is byte-identical to a prior shipped value and not already the current text. */
export function isPristineStalePrompt(prompt: string, spec: PristinePromptSpec): boolean {
  return prompt !== spec.current && spec.priorValues.includes(prompt);
}

/**
 * Refresh the pristine agents of ONE reserved home to their spec's current prompt. `agents` is the home's
 * agent list (callers resolve the home; this never searches outside it). Returns the names refreshed.
 */
export function refreshPristinePrompts(db: Db, agents: readonly Agent[], specs: readonly PristinePromptSpec[]): string[] {
  const refreshed: string[] = [];
  for (const agent of agents) {
    const spec = specs.find((s) => s.agentName === agent.name);
    if (!spec) continue; // a user-renamed or unrelated agent
    if (!isPristineStalePrompt(agent.startupPrompt, spec)) continue; // customized, or already current
    db.updateAgent(agent.id, { startupPrompt: spec.current });
    refreshed.push(agent.name);
  }
  return refreshed;
}
