// Text normalisation shared by search and by data cleanup.

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
