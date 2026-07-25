#!/usr/bin/env bun
// MCP server: lets an AI agent use Cine Colombia conversationally.
//
// The tools are thin adapters over the same services the CLI uses, so behaviour
// cannot drift between the two surfaces.
//
// Buying is split deliberately. `cotizar_compra` is read-only and safe to call
// freely; `crear_orden` holds real seats for about five minutes and therefore
// requires an explicit `confirmar: true`. That guard lives in code rather than in
// the prompt, because an instruction telling a model to ask first is a request, not
// a constraint.
//
// Payment is never automated: Cine Colombia redirects to PlacetoPay, a hosted PCI
// gateway that fingerprints the device to detect automation. The tools return the
// payment URL for a human to open.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DEFAULTS } from '../config/constants.js';
import { matchTicketTypeForArea, resolveSeatCodes, seatCode } from '../lib/booking.js';
import { formatBusinessDate, formatMoney, formatTime, parseUserDate } from '../lib/format.js';
import { filterByCity, listCities, searchFilms, searchTheatres } from '../lib/search.js';
import { listAvailableSeats, renderSeatMap, summariseAvailableSeats } from '../lib/seat-map.js';
import { blankToUndefined } from '../lib/text.js';
import { cineApi } from '../services/api/ocapi-client.js';
import { orderService } from '../services/api/order-service.js';

const server = new McpServer({ name: 'cine-colombia', version: '0.1.0' });

/** MCP returns text content; JSON keeps it parseable for the model. */
function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

/**
 * Say that a required value arrived empty.
 *
 * Models send `""` for fields they could not fill. Without this the empty string
 * flows into a search, which treats it as "no filter" and returns everything, and
 * the `[0]` that follows becomes an arbitrary film or theatre presented as the
 * answer. An error the model can act on is far better than a confident wrong one.
 */
function missing(field: string, hint: string) {
  return fail(`Falta "${field}": ${hint} No se asumió ningún valor.`);
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

server.tool(
  'ver_cartelera',
  'Lista las películas en cartelera. Con una ciudad, devuelve solo las que tienen funciones hoy y cuántas.',
  {
    ciudad: z.string().optional().describe('Ciudad, por ejemplo Bogotá o Medellín'),
    genero: z.string().optional().describe('Filtrar por género, por ejemplo terror'),
  },
  async ({ ciudad: ciudadInput, genero: generoInput }) => {
    const ciudad = blankToUndefined(ciudadInput);
    const genero = blankToUndefined(generoInput);
    const films = await cineApi.getFilms();

    let selected = films;
    let businessDate: string | null = null;
    const counts = new Map<string, number>();

    if (ciudad) {
      const theatres = filterByCity(
        (await cineApi.getTheatres()).filter((theatre) => theatre.sellsTickets),
        ciudad
      );
      if (theatres.length === 0) {
        return fail(
          `No hay teatros en "${ciudad}". Ciudades: ${listCities(await cineApi.getTheatres()).join(', ')}`
        );
      }

      const result = await cineApi.getShowtimes('first', {
        theatreIds: theatres.map((theatre) => theatre.id),
      });
      businessDate = result.businessDate;
      for (const showtime of result.showtimes) {
        counts.set(showtime.filmId, (counts.get(showtime.filmId) ?? 0) + 1);
      }
      // Intersect with real showtimes so the answer is "what can I watch",
      // not "what exists in the catalogue".
      selected = films.filter((film) => counts.has(film.id));
    }

    if (genero) {
      selected = selected.filter((film) =>
        film.genres.some((g) => g.toLowerCase().includes(genero.toLowerCase()))
      );
    }

    return json({
      fecha: businessDate,
      total: selected.length,
      peliculas: selected.map((film) => ({
        id: film.id,
        titulo: film.localTitle ?? film.title,
        tituloOriginal: film.title,
        duracionMinutos: film.runtimeMinutes,
        clasificacion: film.rating,
        generos: film.genres,
        funciones: counts.get(film.id) ?? null,
      })),
    });
  }
);

server.tool(
  'ver_pelicula',
  'Detalle de una película: sinopsis, duración, clasificación, géneros, reparto y tráiler.',
  { busqueda: z.string().describe('Título o ID de la película') },
  async ({ busqueda }) => {
    const query = blankToUndefined(busqueda);
    if (!query) return missing('busqueda', 'indica el título o el ID de la película.');

    const film = searchFilms(await cineApi.getFilms(), query)[0];
    if (!film) return fail(`No se encontró ninguna película que coincida con "${query}".`);

    return json({
      id: film.id,
      titulo: film.localTitle ?? film.title,
      tituloOriginal: film.title,
      sinopsis: film.synopsis,
      duracionMinutos: film.runtimeMinutes,
      clasificacion: film.rating,
      edadMinima: film.minimumAge,
      generos: film.genres,
      reparto: film.cast,
      trailer: film.trailerUrl,
      estreno: film.releaseDate,
    });
  }
);

server.tool(
  'ver_teatros',
  'Lista los teatros de Cine Colombia, con dirección y coordenadas. Puede ordenar por cercanía.',
  {
    ciudad: z.string().optional(),
    cerca: z
      .string()
      .optional()
      .describe('Coordenada "lat,lng" para ordenar por cercanía, por ejemplo "4.6533,-74.0836"'),
  },
  async ({ ciudad: ciudadInput, cerca: cercaInput }) => {
    const ciudad = blankToUndefined(ciudadInput);
    const cerca = blankToUndefined(cercaInput);

    let theatres = (await cineApi.getTheatres()).filter((theatre) => theatre.sellsTickets);
    if (ciudad) theatres = filterByCity(theatres, ciudad);
    if (theatres.length === 0) return fail(`No hay teatros que coincidan con "${ciudad ?? ''}".`);

    let distances: Map<string, number> | undefined;
    if (cerca) {
      const [lat, lng] = cerca.split(',').map((part) => Number.parseFloat(part.trim()));
      if (lat === undefined || lng === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
        return fail('La coordenada debe verse como "4.6533,-74.0836".');
      }
      const { distanceKm } = await import('../lib/search.js');
      distances = new Map(
        theatres
          .filter((theatre) => theatre.location)
          .map((theatre) => [
            theatre.id,
            distanceKm(
              { latitude: lat, longitude: lng },
              theatre.location as { latitude: number; longitude: number }
            ),
          ])
      );
      theatres = [...theatres].sort(
        (a, b) =>
          (distances?.get(a.id) ?? Number.POSITIVE_INFINITY) -
          (distances?.get(b.id) ?? Number.POSITIVE_INFINITY)
      );
    }

    return json(
      theatres.map((theatre) => ({
        id: theatre.id,
        nombre: theatre.name,
        ciudad: theatre.city,
        direccion: theatre.address,
        distanciaKm: distances?.get(theatre.id)
          ? Number(distances.get(theatre.id)?.toFixed(1))
          : null,
      }))
    );
  }
);

server.tool(
  'ver_horarios',
  'Horarios de una película. Devuelve IDs de función necesarios para ver sillas o comprar.',
  {
    pelicula: z.string().describe('Título o ID de la película'),
    ciudad: z.string().optional().describe(`Por defecto ${DEFAULTS.city}`),
    teatro: z.string().optional().describe('Nombre o ID de un teatro específico'),
    fecha: z.string().optional().describe('Fecha en formato DD-MM-YYYY'),
  },
  async ({ pelicula, ciudad, teatro, fecha }) => {
    const query = blankToUndefined(pelicula);
    if (!query) return missing('pelicula', 'indica el título o el ID de la película.');

    const film = searchFilms(await cineApi.getFilms(), query)[0];
    if (!film) return fail(`No se encontró ninguna película que coincida con "${query}".`);

    const wantedCity = blankToUndefined(ciudad);
    const wantedTheatre = blankToUndefined(teatro);
    const wantedDate = blankToUndefined(fecha);

    let businessDate: string | 'first' = 'first';
    if (wantedDate) {
      try {
        businessDate = parseUserDate(wantedDate);
      } catch {
        return fail(`"${wantedDate}" no es una fecha válida. Usa DD-MM-YYYY.`);
      }
    }

    const sellable = (await cineApi.getTheatres()).filter((t) => t.sellsTickets);
    const theatres = wantedTheatre
      ? searchTheatres(sellable, wantedTheatre).slice(0, 1)
      : filterByCity(sellable, wantedCity ?? DEFAULTS.city);

    if (theatres.length === 0) {
      return fail(`No se encontraron teatros para "${wantedTheatre ?? wantedCity}".`);
    }

    const { businessDate: date, showtimes } = await cineApi.getShowtimes(businessDate, {
      filmIds: [film.id],
      theatreIds: theatres.map((t) => t.id),
    });

    const byId = new Map(theatres.map((t) => [t.id, t]));

    return json({
      pelicula: film.localTitle ?? film.title,
      fecha: date,
      fechaLegible: formatBusinessDate(date),
      funciones: showtimes.map((showtime) => ({
        id: showtime.id,
        teatro: byId.get(showtime.theatreId)?.name ?? showtime.theatreId,
        hora: formatTime(showtime.startsAt, byId.get(showtime.theatreId)?.timeZone),
        agotada: showtime.isSoldOut,
        es3d: showtime.requires3dGlasses,
      })),
    });
  }
);

server.tool(
  'ver_asientos',
  'Sillas libres y ocupadas de una función, con precios de boleta. Devuelve además un ' +
    'mapa de la sala en texto, ya dibujado: mostrálo tal cual, sin redibujarlo, para que ' +
    'la persona vea dónde está cada silla respecto de la pantalla.',
  { funcion: z.string().describe('ID de la función, por ejemplo 6493-7850') },
  async ({ funcion: funcionInput }) => {
    const funcion = blankToUndefined(funcionInput);
    if (!funcion) return missing('funcion', 'usa un ID de función de ver_horarios.');

    try {
      const [layout, availability, ticketTypes] = await Promise.all([
        cineApi.getSeatLayout(funcion),
        cineApi.getSeatAvailability(funcion, { refresh: true }),
        cineApi.getTicketTypes(funcion),
      ]);

      const free = listAvailableSeats(layout, availability);

      const data = {
        funcion,
        agotada: availability.isSoldOut,
        libres: availability.availableCount,
        total: availability.totalCount,
        sillasPorFila: summariseAvailableSeats(free).map((row) => ({
          fila: row.row,
          area: row.area,
          sillas: row.numbers,
        })),
        boletas: ticketTypes
          .filter((type) => !type.isRestricted)
          .map((type) => ({ id: type.id, nombre: type.name, precio: type.price })),
      };

      // The map goes in its own block, as plain text.
      //
      // A list of free seat numbers answers "is there space"; the map answers "where
      // will I be sitting", which is the actual question. Rendered here rather than
      // left to the model because the geometry is not in the JSON: which rows are
      // closer to the screen, where the aisles fall, and that the alphabet runs
      // continuously across areas. A model asked to draw it would invent a plausible
      // room instead of this one. Uncoloured because ANSI escapes in a tool result
      // are noise to whatever is reading it.
      return {
        content: [
          {
            type: 'text' as const,
            text: renderSeatMap(layout, availability, { plain: true }).join('\n'),
          },
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    } catch {
      return fail(`No se encontró la función "${funcion}" o ya terminó.`);
    }
  }
);

server.tool(
  'ver_confiteria',
  'Menú de confitería de un teatro. Por defecto la sección de crispetas, bebidas y combos.',
  {
    teatro: z.string().describe('Nombre o ID del teatro'),
    seccion: z.string().optional().describe('Otra sección, por ejemplo sushi'),
  },
  async ({ teatro, seccion }) => {
    const query = blankToUndefined(teatro);
    if (!query) return missing('teatro', 'indica el nombre o el ID del teatro.');

    const found = searchTheatres(
      (await cineApi.getTheatres()).filter((t) => t.sellsTickets),
      query
    )[0];
    if (!found) return fail(`No se encontró el teatro "${query}".`);

    const sections = await cineApi.getMenu(found.id);
    // Blank must fall back to the default section, not match every section.
    const needle = (blankToUndefined(seccion) ?? 'confiteria').toLowerCase();
    const selected = sections.filter((section) => section.name.toLowerCase().includes(needle));

    return json({
      teatro: found.name,
      seccionesDisponibles: sections.map((section) => section.name),
      productos: (selected.length > 0 ? selected : sections.slice(0, 1)).flatMap((section) =>
        section.items.map((item) => ({
          seccion: section.name,
          nombre: item.name,
          precio: item.price,
          requierePromocion: item.isRestricted,
        }))
      ),
    });
  }
);

server.tool(
  'ver_cuenta',
  'Muestra la cuenta vinculada y las boletas activas. Vacío si no hay sesión.',
  {},
  async () => {
    const member = await cineApi.getMember();
    if (!member) {
      return json({
        sesion: false,
        mensaje: 'No hay sesión. El usuario debe ejecutar "cine login" en su terminal.',
      });
    }

    return json({
      sesion: true,
      nombre: member.fullName,
      correo: member.email,
      miembro: member.id,
      boletasActivas: (await cineApi.getActiveOrders().catch(() => [])).map((order) => ({
        pelicula: order.filmTitle,
        teatro: order.theatreName,
        inicia: order.startsAt,
        boletas: order.ticketCount,
        total: order.total,
      })),
    });
  }
);

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

server.tool(
  'cotizar_compra',
  'Calcula el precio de unas sillas SIN crear la orden ni apartar nada. Seguro de llamar siempre.',
  {
    funcion: z.string().describe('ID de la función'),
    sillas: z.string().describe('Sillas separadas por coma, por ejemplo "A5,A6"'),
  },
  async ({ funcion: funcionInput, sillas: sillasInput }) => {
    const funcion = blankToUndefined(funcionInput);
    const sillas = blankToUndefined(sillasInput);
    if (!funcion) return missing('funcion', 'usa un ID de función de ver_horarios.');
    if (!sillas) return missing('sillas', 'indica las sillas, por ejemplo "A5,A6".');

    const [layout, availability, ticketTypes] = await Promise.all([
      cineApi.getSeatLayout(funcion),
      cineApi.getSeatAvailability(funcion, { refresh: true }),
      cineApi.getTicketTypes(funcion),
    ]);

    const free = listAvailableSeats(layout, availability);
    const { matched, unmatched, duplicates } = resolveSeatCodes(sillas, free);

    if (unmatched.length > 0) return fail(`No están disponibles: ${unmatched.join(', ')}`);
    if (duplicates.length > 0) return fail(`Sillas repetidas: ${duplicates.join(', ')}`);
    if (matched.length === 0) return fail('No se indicó ninguna silla.');

    const lines = matched.map((seat) => {
      const type = matchTicketTypeForArea(seat.areaName, ticketTypes);
      return {
        silla: seatCode(seat.seat),
        area: seat.areaName,
        boleta: type?.name ?? null,
        boletaId: type?.id ?? null,
        precio: type?.price ?? null,
      };
    });

    const subtotal = lines.reduce((sum, line) => sum + (line.precio ?? 0), 0);

    return json({
      funcion,
      sillas: lines,
      subtotal,
      subtotalLegible: formatMoney(subtotal),
      nota: 'Cine Colombia suma un cargo por servicio; el total exacto lo confirma la orden. No se apartó ninguna silla.',
    });
  }
);

server.tool(
  'crear_orden',
  'APARTA SILLAS REALES por ~5 minutos y devuelve el enlace de pago. Requiere confirmar:true. ' +
    'Llama antes a cotizar_compra y confirma con la persona. El pago lo completa un humano en el navegador.',
  {
    funcion: z.string().describe('ID de la función'),
    sillas: z.string().describe('Sillas separadas por coma'),
    confirmar: z
      .boolean()
      .describe('Debe ser true. Confirma que la persona aceptó apartar las sillas.'),
    nombre: z.string().optional().describe('Solo si no hay sesión vinculada'),
    apellido: z.string().optional(),
    correo: z.string().optional(),
    cedula: z.string().optional(),
  },
  async ({
    funcion: funcionInput,
    sillas: sillasInput,
    confirmar,
    nombre,
    apellido,
    correo,
    cedula,
  }) => {
    if (!confirmar) {
      return fail(
        'No se creó nada: "confirmar" debe ser true. Muestra primero la cotización y pide autorización explícita.'
      );
    }

    const funcion = blankToUndefined(funcionInput);
    const sillas = blankToUndefined(sillasInput);
    if (!funcion) return missing('funcion', 'usa un ID de función de ver_horarios.');
    if (!sillas) return missing('sillas', 'indica las sillas, por ejemplo "A5,A6".');

    const [showtime, layout, availability, ticketTypes] = await Promise.all([
      cineApi.getShowtime(funcion),
      cineApi.getSeatLayout(funcion),
      cineApi.getSeatAvailability(funcion, { refresh: true }),
      cineApi.getTicketTypes(funcion),
    ]);

    const free = listAvailableSeats(layout, availability);
    const { matched, unmatched } = resolveSeatCodes(sillas, free);
    if (unmatched.length > 0) return fail(`No están disponibles: ${unmatched.join(', ')}`);
    if (matched.length === 0) return fail('No se indicó ninguna silla.');

    // Prefer the linked account so the buyer never has to dictate personal data.
    const member = await cineApi.getMember().catch(() => null);
    // Blank fields must not shadow the account's own details.
    const customer = {
      givenName: blankToUndefined(nombre) ?? member?.givenName ?? '',
      familyName: blankToUndefined(apellido) ?? member?.familyName ?? '',
      email: blankToUndefined(correo) ?? member?.email ?? '',
      identification: blankToUndefined(cedula) ?? member?.nationalId ?? '',
    };

    if (!customer.givenName || !customer.email || !customer.identification) {
      return fail(
        'Faltan datos del comprador. Pide nombre, apellido, correo y cédula, o dile a la persona que ejecute "cine login".'
      );
    }

    const selections = matched.map((seat) => {
      const type = matchTicketTypeForArea(seat.areaName, ticketTypes);
      if (!type) throw new Error(`No se pudo determinar el tipo de boleta para ${seat.areaName}`);
      return { seatId: seat.seat.id, ticketTypeId: type.id };
    });

    const order = await orderService.createOrder(showtime.theatreId);

    try {
      const withSeats = await orderService.setSeats(order.id, funcion, selections);
      await orderService.setCustomer(order.id, customer);
      const payment = await orderService.createPaymentRedirect(order.id);

      // El vencimiento se entrega ya legible y en hora de Colombia, además del ISO.
      //
      // Devolver solo el ISO en UTC no era neutral: el modelo lo mostraba tal cual, y
      // a la 1:11 de la mañana leer "vence 06:39 AM" hace pensar que hay cinco horas
      // de margen cuando quedan cinco minutos. Un dato correcto presentado en otra
      // zona horaria desinforma igual que un dato equivocado.
      const vence = payment.expiresAt ?? null;
      const minutosRestantes = vence
        ? Math.max(0, Math.round((new Date(vence).getTime() - Date.now()) / 60000))
        : null;

      return json({
        orden: order.id,
        sillas: matched.map(({ seat }) => seatCode(seat)),
        total: withSeats.totalPrice.valueIncludingTax,
        totalLegible: formatMoney(withSeats.totalPrice.valueIncludingTax),
        cargoServicio: withSeats.bookingFee?.valueIncludingTax ?? null,
        enlacePago: payment.url,
        vence,
        venceLegible: vence ? `${formatTime(vence)} (hora de Colombia)` : null,
        minutosRestantes,
        instruccion:
          'Entrega el enlace a la persona para que pague en su navegador. Al avisar cuándo ' +
          'vence usa "minutosRestantes" o "venceLegible", nunca el campo "vence" en crudo: ' +
          'está en UTC y confunde a quien no esté en esa zona.',
      });
    } catch (error) {
      // Never leave seats blocked because our own sequence failed.
      await orderService.cancelOrder(order.id);
      return fail(
        `No se pudo completar la orden, así que se canceló y se liberaron las sillas. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
);

server.tool(
  'cancelar_orden',
  'Cancela una orden sin pagar y libera sus sillas de inmediato.',
  { orden: z.string().describe('ID de la orden') },
  async ({ orden: ordenInput }) => {
    const orden = blankToUndefined(ordenInput);
    if (!orden) return missing('orden', 'indica el ID que devolvió crear_orden.');

    const released = await orderService.cancelOrder(orden);
    return json({
      cancelada: released,
      mensaje: released
        ? 'Orden cancelada y sillas liberadas.'
        : 'No se pudo cancelar; las sillas se liberan solas al vencer.',
    });
  }
);

await server.connect(new StdioServerTransport());
