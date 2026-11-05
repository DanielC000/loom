// Display-only sentence case for short UI labels whose source is a lowercase literal or a value
// ("active workers" -> "Active workers"). Only the first character changes, so ids and acronyms
// later in the string are left as they are. Never apply it to a value that is compared in code.
export function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}
