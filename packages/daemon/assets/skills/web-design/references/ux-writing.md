# UX writing

Copy is part of the design. The fastest way to spot generated UI is often to read it — the words give
it away before the pixels do.

## Buttons & actions

- **Label = verb + object.** "Create project", "Delete file", "Send invite". **Never** generic labels
  like OK / Submit / Yes / Continue when a specific one is possible — the user should know what the
  button does without reading the surrounding context.

## Errors

- **Error formula: what happened → why → how to fix.** "Couldn't save — you're offline. Reconnect and
  try again." not "Error" or "Something went wrong."
- **Never use humor in error messages.** A user hitting an error is frustrated; a joke lands as
  mockery.
- **Never blame the user.** "That email's already registered" not "You entered an invalid email."

## Empty states

- An empty state is an opportunity, not a dead end. **Say what goes here and how to add the first
  one**: "No projects yet. Create one to get started. [Create project]".

## Voice & tone

- **Voice is constant; tone adapts.** The product sounds like one consistent personality everywhere,
  but the tone flexes to context — lighter on an onboarding success, plain and direct on an error.
- Keep a small **terminology glossary** and use terms consistently — don't call the same thing a
  "project" in one place and a "workspace" in another.
- Budget for **i18n expansion** — translated strings can run 30–40% longer; don't design copy that
  only fits in English.

## Accessible copy

- **Link text must stand alone** — "Read the pricing guide", never "click here" (screen-reader users
  navigate by link text out of context).
- **Alt text is informative**, not decorative-redundant — describe what the image conveys, or mark it
  empty (`alt=""`) if it's purely decorative.

## The anti-AI-tell denylist

Generated copy has a recognizable cadence. Strip these on sight:

- **No em-dashes** (`—` or `--`). The em-dash is the single strongest AI-cadence tell. Use a period, a
  colon, or parentheses.
- **No marketing buzzwords**: streamline, empower, supercharge, seamless, world-class, next-generation,
  leverage, robust, elevate, unlock, delve, tapestry, pivotal, "in today's …", "let's dive in", "in
  conclusion".
- **No aphoristic negation pivots** repeated as structure: "Not just X — it's Y." One is a flourish;
  every section opening that way is a tell.
- **No triadic-everything** (relentless rule-of-three lists) and **no uniform sentence rhythm** —
  vary length; real writing has a pulse.
- **No "Jane Doe" placeholders, fake-perfect numbers** (99.99%, exactly 50%), or generic company names
  ("Acme Inc") in anything that ships — they read as filler.
