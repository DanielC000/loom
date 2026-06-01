import type { CSSProperties } from "react";
import { color } from "./theme";

// Page content padding. The former card/btn/input objects are superseded by the
// component kit (components/ui) and have been removed now that every page uses it.
export const page: CSSProperties = { padding: 20, color: color.text };
