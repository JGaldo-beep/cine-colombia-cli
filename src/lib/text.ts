// Text normalisation shared by search and by data cleanup.

/**
 * Treat a blank string as no value at all.
 *
 * Language models routinely send `""` for a field they have no value for, and an
 * empty string is not the same request as an omitted one. It matters most where a
 * search is used to resolve a single thing: `searchFilms` answers an empty query
 * with every film, so an unguarded `[0]` would return an arbitrary film as though
 * it had been asked for — a confident wrong answer rather than a visible error.
 */
export function blankToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Fold text into a comparable form: lowercase, unaccented, single-spaced.
 *
 * Decomposing to NFD splits "á" into "a" plus a combining accent; `\p{Mn}`
 * (Unicode nonspacing marks) then removes the accents, leaving plain ASCII for
 * Spanish text. This is what lets "bogota" match "Bogotá".
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
