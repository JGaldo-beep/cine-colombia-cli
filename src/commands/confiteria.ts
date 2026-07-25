// `cine confiteria <teatro>` — the food and drink menu.
//
// Sections are the theatre's own ("Confiteria", "Sushi", "Cinepolitana", "Juan
// Valdez"), so the CLI shows the snack section by default without hardcoding a list
// of product names, which would break the moment the menu changes.

import pc from 'picocolors';
import { NotFoundError } from '../lib/errors.js';
import { formatMoney, padVisible, truncate } from '../lib/format.js';
import { searchTheatres } from '../lib/search.js';
import { normalizeText } from '../lib/text.js';
import { cineApi } from '../services/api/ocapi-client.js';
import type { MenuSection } from '../types/member.js';

export interface ConfiteriaOptions {
  /** Show a specific section by name, e.g. "sushi". */
  menu?: string;
  /** Show every section. */
  todo?: boolean;
  /** Filter items by name. */
  buscar?: string;
  refrescar?: boolean;
  json?: boolean;
}

/** Section shown when none is requested: popcorn, drinks and combos. */
const DEFAULT_SECTION = 'confiteria';

export async function confiteria(
  theatreQuery: string,
  options: ConfiteriaOptions = {}
): Promise<void> {
  const theatres = await cineApi.getTheatres();
  const theatre = searchTheatres(
    theatres.filter((candidate) => candidate.sellsTickets),
    theatreQuery
  )[0];

  if (!theatre) {
    throw new NotFoundError(
      'THEATRE_NOT_FOUND',
      `No se encontró el teatro "${theatreQuery}". Lista disponible: cine teatros`,
      { query: theatreQuery }
    );
  }

  const sections = await cineApi.getMenu(theatre.id, { refresh: options.refrescar });
  let selected = pickSections(sections, options);

  if (options.buscar) {
    const needle = normalizeText(options.buscar);
    selected = selected
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => normalizeText(item.name).includes(needle)),
      }))
      .filter((section) => section.items.length > 0);
  }

  if (options.json) {
    console.log(JSON.stringify({ theatre, sections: selected }, null, 2));
    return;
  }

  console.log(`\n${pc.bold(pc.cyan(`Confitería · ${theatre.name}`))}`);

  if (selected.length === 0) {
    console.log(pc.yellow('\n  No hay productos que coincidan con esos filtros.'));
    console.log(
      pc.dim(`  Secciones disponibles: ${sections.map((section) => section.name).join(', ')}\n`)
    );
    return;
  }

  for (const section of selected) {
    console.log(`\n  ${pc.bold(section.name)} ${pc.dim(`(${section.items.length})`)}`);
    for (const item of section.items) {
      // Restricted items need a voucher or promotion, so mark them rather than
      // presenting them as if they were freely purchasable.
      const flag = item.isRestricted ? pc.yellow(' (con promoción)') : '';
      console.log(
        `    ${pc.cyan(padVisible(formatMoney(item.price), 10))} ${truncate(item.name, 42)}${flag}`
      );
    }
  }

  if (!options.todo && !options.menu) {
    const others = sections
      .map((section) => section.name)
      .filter((name) => normalizeText(name) !== DEFAULT_SECTION);
    if (others.length > 0) {
      console.log(pc.dim(`\n  Otras secciones: ${others.join(', ')}`));
      console.log(pc.dim('  Verlas con --menu <nombre> o --todo'));
    }
  }

  console.log();
}

/** Resolve which sections to display, defaulting to the snack counter. */
function pickSections(sections: MenuSection[], options: ConfiteriaOptions): MenuSection[] {
  if (options.todo) return sections;

  if (options.menu) {
    const needle = normalizeText(options.menu);
    return sections.filter((section) => normalizeText(section.name).includes(needle));
  }

  const snacks = sections.filter((section) =>
    normalizeText(section.name).includes(DEFAULT_SECTION)
  );
  // Not every theatre necessarily names a section "Confiteria"; fall back to the
  // first one rather than showing nothing.
  return snacks.length > 0 ? snacks : sections.slice(0, 1);
}
