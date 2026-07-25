#!/usr/bin/env bun
// End-to-end smoke check against the live Cine Colombia API.
//
// Verifies the whole chain: scrape token -> cache it -> query every endpoint the
// client exposes -> map into domain types. Run with `bun run scripts/smoke.ts`.

import { LogLevel, logger } from '../src/lib/logger.js';
import { cineApi } from '../src/services/api/ocapi-client.js';
import { tokenProvider } from '../src/services/auth/token-provider.js';

logger.setLevel(LogLevel.DEBUG);

const creds = await tokenProvider.getCredentials();
console.log('\n== TOKEN ==');
console.log(`api:     ${creds.apiUrl}`);
console.log(`expira:  ${new Date(creds.expiresAt).toLocaleString('es-CO')}`);
console.log(`vigente: ${Math.round((creds.expiresAt - Date.now()) / 60000)} min`);

const theatres = await cineApi.getTheatres();
const bogota = theatres.filter((t) => t.city === 'Bogotá' && t.sellsTickets);
console.log('\n== TEATROS ==');
console.log(
  `total: ${theatres.length} | venden boletas: ${theatres.filter((t) => t.sellsTickets).length}`
);
console.log(`ciudades: ${[...new Set(theatres.map((t) => t.city))].sort().join(', ')}`);
console.log(`Bogotá: ${bogota.length}`);
for (const t of bogota.slice(0, 3)) {
  console.log(
    `  ${t.id}  ${t.name} — ${t.address} (${t.location?.latitude}, ${t.location?.longitude})`
  );
}

const films = await cineApi.getFilms();
console.log('\n== PELÍCULAS ==');
console.log(`total: ${films.length}`);
for (const f of films.slice(0, 3)) {
  console.log(`  ${f.id}  ${f.localTitle ?? f.title} (${f.runtimeMinutes} min) — ${f.rating}`);
  console.log(
    `         géneros: ${f.genres.join(', ') || '—'} | reparto: ${f.cast.slice(0, 3).join(', ') || '—'}`
  );
}

const firstFilm = films[0];
if (!firstFilm) throw new Error('La cartelera vino vacía');

const { businessDate, showtimes } = await cineApi.getShowtimes('first', {
  filmIds: [firstFilm.id],
  theatreIds: bogota.slice(0, 5).map((t) => t.id),
});
console.log('\n== FUNCIONES ==');
console.log(
  `película: ${firstFilm.localTitle ?? firstFilm.title} | fecha: ${businessDate} | funciones: ${showtimes.length}`
);
for (const s of showtimes.slice(0, 5)) {
  const theatre = theatres.find((t) => t.id === s.theatreId)?.name ?? s.theatreId;
  const hora = new Date(s.startsAt).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
  });
  console.log(`  ${s.id}  ${hora}  ${theatre}${s.isSoldOut ? '  [AGOTADA]' : ''}`);
}

const withSeats = showtimes.find((s) => s.hasAssignedSeating && s.seatLayoutId);
if (withSeats) {
  const layout = await cineApi.getSeatLayout(withSeats.id);
  const total = layout.areas.reduce((sum, a) => sum + a.seats.length, 0);
  console.log('\n== MAPA DE ASIENTOS ==');
  console.log(`función ${withSeats.id} | sala ${layout.screenId} | asientos: ${total}`);
  for (const area of layout.areas) {
    const rows = [...new Set(area.seats.map((s) => s.row))];
    console.log(
      `  ${area.name}: ${area.seats.length} asientos, filas ${rows[0]}–${rows[rows.length - 1]}`
    );
  }
} else {
  console.log('\n== MAPA DE ASIENTOS ==\n  (ninguna función con asiento asignado en la muestra)');
}

console.log('\n✓ Smoke test completo\n');
