/**
 * The ONE validator for preset-prompt text fields — shared by the REST preset routes and both auditor
 * MCP surfaces' `preset_suggestion_suggest`, so a suggestion is refused the same way whichever writer
 * files it (a blank label used to be a 400 over REST but stored fine via MCP).
 */

/** Bounds for the Preset Prompts surfaces (label = short button text; prompt = the text to send). */
export const PRESET_LABEL_MAX = 200;
export const PRESET_PROMPT_MAX = 10_000;
export const PRESET_RATIONALE_MAX = 2_000;

/** Validate a preset string field: must be a non-blank string within its bound. Returns an error
 *  message (for a 400 / MCP error) or null when valid. */
export const validatePresetField = (name: string, v: unknown, max: number): string | null => {
  if (typeof v !== "string") return `${name} must be a string`;
  if (v.trim().length === 0) return `${name} must not be empty`;
  if (v.length > max) return `${name} must be at most ${max} characters`;
  return null;
};

/** Validate a whole suggestion input (label, prompt, optional rationale). Returns an error message or null. */
export const validatePresetSuggestion = (b: { label?: unknown; prompt?: unknown; rationale?: unknown }): string | null => {
  const err = validatePresetField("label", b.label, PRESET_LABEL_MAX) ?? validatePresetField("prompt", b.prompt, PRESET_PROMPT_MAX);
  if (err) return err;
  if (b.rationale !== undefined && b.rationale !== null) {
    if (typeof b.rationale !== "string") return "rationale must be a string";
    if (b.rationale.length > PRESET_RATIONALE_MAX) return `rationale must be at most ${PRESET_RATIONALE_MAX} characters`;
  }
  return null;
};
