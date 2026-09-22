# 2790ce05 — connector `host`, `secret`, `clientId` and `clientSecret` PERSIST across a preset switch, by decision

## Narrative

Card `7fba8d90` fixed the **Name** field in `ConnectionForm` (`packages/web/src/pages/Settings.tsx`) carrying a stale preset-derived value across a connector preset switch. Card `2790ce05` asked the obvious follow-up: should `host`, `secret` and `clientId` reset too? **The answer is no, for every one of them, and this record exists so the next reader of `7fba8d90` does not reflexively "finish the job".**

**The Name fix is not generalisable, and the reason is structural rather than a matter of taste.** `nameTouched` discriminates *preset-derived* from *user-owned*: the Name has a preset default (`CONNECTOR_PRESET_NAMES`) to revert to, so re-deriving it destroys nothing. **No other field in this form has a preset default at all.** Measured at source: the only programmatic (non-`onChange`) write to any field state in `ConnectionForm` is `setName(CONNECTOR_PRESET_NAMES[m])` inside `selectMode`. Every write to `host`, `secret`, `clientId`, `clientSecret`, `authUrl` and `tokenUrl` is that field's own `<Input onChange>`. The two other preset constants are not state writes: `GA_PRESET_HOST` is a submit-time literal (Google Analytics never renders a Host field), and `GOOGLE_ANALYTICS_SCOPE_PRESETS` drives checkboxes.

⇒ **A host or a credential in this form is user-typed 100% of the time.** So `nameTouched` has nothing to revert to here, and any "reset on switch" is not a re-derivation but a plain destruction of the user's unfinished input — which this project has a standing owner rule against.

**Per field, the positive case is stronger than mere non-destruction — every reachable transition preserves the field's MEANING:**

- **`host`** — SonarQube and Custom both mean "a bare hostname" (`normalizeSonarQubeHost` only strips a pasted scheme on the SonarQube submit path). Google Analytics never renders the field and ignores the state entirely at submit, so `host` is only ever visible across those two presets — exactly the pair where the meaning is identical. Carrying it over is help.
- **`secret`** — SonarQube's "User token" and Custom's api-key/bearer "Secret" are one state field behind two labels, and both mean "an opaque bearer credential for `host`". A user switching SonarQube → Custom to pick a different auth scheme for the same server keeps both host and token, which is the behaviour they want.
- **`clientId` / `clientSecret`** — Google Analytics and Custom+oauth2 both mean "an OAuth app the user registered themselves". Identical meaning, identical answer. **Note `clientSecret`: the card's own enumeration named only `secret` and `clientId`, but `clientSecret` persists identically and is the actual password-type OAuth credential. Any future revisit must cover four fields, not three.**

**Two things bound the value of changing anything here, and both argue for leaving it alone.** The Name bug was actively *disguised* — its placeholder updated correctly while the value went stale, so the field read as empty-and-sensible; a persisted host or token has no such disguise and is plainly visible in its box. And the form is conditionally mounted (`{adding && <ConnectionForm …/>}`), so all of this state is destroyed on Cancel or on leaving the page: persistence lives only inside one continuously-open form.

**A non-destructive remedy** — surfacing that a credential was entered under a different preset — was evaluated and **rejected**. It would fire on the helpful cases too (SonarQube → Custom carrying the same token to the same host), turning correct behaviour into a warning; it would require per-field "entered-under-mode" tracking, i.e. exactly the second, subtly-different dirty-flag that `7fba8d90`'s DoD warns against; and next to a password-type field rendered as dots it adds noise without information.

## Do not

- Do not extend `7fba8d90`'s Name reset to `host`, `secret`, `clientId` or `clientSecret`. Those fields have no preset-derived default to revert to, so a reset destroys user-typed input rather than re-deriving anything.
- Do not add a second dirty-flag (per-field "touched" or "entered-under-mode" state) alongside `nameTouched` in this component. A shared-unit divergence here is a named recurring cost on this project; if a field ever genuinely needs the distinction, reuse `nameTouched`'s shape rather than inventing a parallel one.
- Do not assert this behaviour on a field's `placeholder`. A placeholder pin reads green against both broken and fixed code — the defect class of `7fba8d90` and `5a8a74e1`. Assert `input.value`.

## Source

`packages/web/src/pages/Settings.tsx` › `ConnectionForm` / `selectMode` (anchored there). Pinned by `packages/web/e2e/connections-preset-name.spec.ts` › "host and credentials PERSIST across a preset switch". Decided on card `2790ce05`; parent card `7fba8d90`.
