import type { SelectorRequirement } from "./types";

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function extractSelectorRequirements(prompt: string): SelectorRequirement {
  const ids = [
    ...prompt.matchAll(/id=["'`]?([A-Za-z][\w:-]*)["'`]?/g),
    ...prompt.matchAll(/id为["'`]?([A-Za-z][\w:-]*)["'`]?/g),
    ...prompt.matchAll(/id\s*[:：]\s*["'`]?([A-Za-z][\w:-]*)["'`]?/g),
    ...prompt.matchAll(/id\s*=\s*["'`]([^"'`]+)["'`]/g),
  ].map((match) => match[1]);

  const classes = [
    ...prompt.matchAll(/class=["'`]?([A-Za-z][\w:-]*)["'`]?/g),
    ...prompt.matchAll(/类名为["'`]?([A-Za-z][\w:-]*)["'`]?/g),
    ...prompt.matchAll(/类名\s*[:：]\s*["'`]?([A-Za-z][\w:-]*)["'`]?/g),
    ...prompt.matchAll(/className=["'`]?([A-Za-z][\w:-]*)["'`]?/g),
    ...prompt.matchAll(/class\s*=\s*["'`]([^"'`]+)["'`]/g),
  ].flatMap((match) => String(match[1]).split(/\s+/));

  return {
    ids: unique(ids),
    classes: unique(classes),
  };
}

export function trimForPrompt(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}
