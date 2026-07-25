// `cine comprar <función>` — pick seats, build the order, hand off to payment.
//
// How far this goes, and why it stops where it does: everything up to and
// including generating the payment link happens here over plain HTTP. The card is
// entered by the human on PlacetoPay, a hosted PCI gateway that fingerprints the
// device specifically to detect automation. Driving that from a CLI would mean
// handling card data and defeating an anti-fraud control, so we don't.
//
// Two consequences shape this command:
//
//   - Attaching seats to an order holds them for ~5 minutes. That affects other
//     customers, so nothing is created without explicit confirmation, and the
//     order is cancelled on every abort or failure path.
//   - The payment link is one-shot and tied to the order. Once it exists the order
//     must NOT be cancelled: the user is on their way to pay.

import * as prompts from '@clack/prompts';
import pc from 'picocolors';
import { matchTicketTypeForArea, resolveSeatCodes, seatCode } from '../lib/booking.js';
import { openInBrowser } from '../lib/browser.js';
import { ApiError, NotFoundError, ValidationError } from '../lib/errors.js';
import { formatBusinessDate, formatMoney, formatTime } from '../lib/format.js';
import { listAvailableSeats, renderSeatMap, summariseAvailableSeats } from '../lib/seat-map.js';
import type { AvailableSeat } from '../lib/seat-map.js';
import { cineApi } from '../services/api/ocapi-client.js';
import {
  type CustomerDetails,
  type SeatSelection,
  orderService,
} from '../services/api/order-service.js';
import type { TicketType } from '../types/cine.js';

export interface ComprarOptions {
  /** Seats to buy, e.g. `"A5,A6"`. Prompted for when absent. */
  sillas?: string;
  /** Force a ticket type id for every seat instead of inferring per area. */
  boleta?: string;
  nombre?: string;
  apellido?: string;
  email?: string;
  cedula?: string;
  /** Show everything and stop before creating the order. Holds no seats. */
  dryRun?: boolean;
  /** Skip the confirmation prompt. */
  si?: boolean;
  /** Print the payment URL instead of opening a browser. */
  sinAbrir?: boolean;
  plain?: boolean;
}

const SHOWTIME_ID_PATTERN = /^\d+-\d+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Colombian identification numbers are 6-11 digits in practice. */
const ID_PATTERN = /^\d{6,11}$/;

export async function comprar(showtimeId: string, options: ComprarOptions = {}): Promise<void> {
  const id = showtimeId.trim();

  if (!SHOWTIME_ID_PATTERN.test(id)) {
    throw new ValidationError(
      'INVALID_SHOWTIME_ID',
      `"${showtimeId}" no parece un ID de función. Deben verse como 6493-7850; los obtienes con "cine horarios <película>".`,
      { showtimeId }
    );
  }

  const context = await loadContext(id, options);
  const { showtime, title, theatreName } = context;

  console.log(`\n${pc.bold(pc.cyan(title))}`);
  console.log(
    pc.dim(
      `${theatreName} · ${formatBusinessDate(showtime.businessDate)} · ${formatTime(showtime.startsAt, context.timeZone)}`
    )
  );

  if (!showtime.hasAssignedSeating) {
    console.log(
      pc.yellow('\nEsta función no tiene asiento asignado, así que no se eligen sillas aquí.')
    );
    console.log(pc.dim(`Cómprala en: ${webCheckoutUrl(id)}\n`));
    return;
  }

  const free = listAvailableSeats(context.layout, context.availability);
  if (context.availability.isSoldOut || free.length === 0) {
    console.log(pc.red('\nFunción agotada: no quedan sillas disponibles.\n'));
    return;
  }

  // Selecting seats without seeing the room is guesswork.
  if (!options.sillas) {
    for (const line of renderSeatMap(context.layout, context.availability, {
      plain: options.plain,
    })) {
      console.log(line);
    }
    console.log();
    console.log(`  ${pc.bold('Sillas libres')}`);
    for (const { row, area, numbers } of summariseAvailableSeats(free)) {
      console.log(
        `    ${pc.dim(area.padEnd(13))} ${pc.cyan(row.padStart(2))}  ${numbers.join(', ')}`
      );
    }
    console.log();
  }

  const seats = await chooseSeats(id, free, options);
  const selections = await chooseTicketTypes(seats, context.ticketTypes, options);
  const total = selections.reduce((sum, entry) => sum + entry.type.price, 0);

  printOrderPreview(selections, total);

  if (options.dryRun) {
    console.log(pc.dim('  --dry-run: no se creó ninguna orden y no se apartó ninguna silla.\n'));
    return;
  }

  const customer = await resolveCustomer(options);

  if (!options.si) {
    const proceed = await prompts.confirm({
      message: `Crear la orden y apartar ${selections.length === 1 ? 'la silla' : `las ${selections.length} sillas`} por ~5 minutos?`,
      initialValue: false,
    });

    if (prompts.isCancel(proceed) || !proceed) {
      console.log(pc.dim('\nCancelado. No se apartó ninguna silla.\n'));
      return;
    }
  }

  await placeOrder(id, showtime.theatreId, selections, customer, options);
}

/** Fetch everything the flow needs, failing early with a useful message. */
async function loadContext(id: string, options: ComprarOptions) {
  try {
    const [showtime, layout, availability, ticketTypes] = await Promise.all([
      cineApi.getShowtime(id),
      cineApi.getSeatLayout(id),
      // Always fresh: a stale map would offer seats somebody already bought.
      cineApi.getSeatAvailability(id, { refresh: true }),
      cineApi.getTicketTypes(id),
    ]);

    const [films, theatres] = await Promise.all([
      cineApi.getFilms().catch(() => []),
      cineApi.getTheatres().catch(() => []),
    ]);

    const film = films.find((candidate) => candidate.id === showtime.filmId);
    const theatre = theatres.find((candidate) => candidate.id === showtime.theatreId);

    return {
      showtime,
      layout,
      availability,
      ticketTypes,
      title: film ? (film.localTitle ?? film.title) : showtime.filmId,
      theatreName: theatre?.name ?? showtime.theatreId,
      timeZone: theatre?.timeZone,
      plain: options.plain,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new NotFoundError(
        'SHOWTIME_NOT_FOUND',
        `No se encontró la función "${id}". Puede que ya haya terminado o que el ID esté mal.`,
        { showtimeId: id }
      );
    }
    throw error;
  }
}

async function chooseSeats(
  showtimeId: string,
  free: AvailableSeat[],
  options: ComprarOptions
): Promise<AvailableSeat[]> {
  const input =
    options.sillas ??
    (await (async () => {
      const answer = await prompts.text({
        message: 'Qué sillas quieres? (por ejemplo A5,A6)',
        placeholder: free
          .slice(0, 2)
          .map(({ seat }) => seatCode(seat))
          .join(','),
        validate: (value) => {
          if (!value?.trim()) return 'Escribe al menos una silla.';
          const { unmatched } = resolveSeatCodes(value, free);
          if (unmatched.length > 0) return `No están disponibles: ${unmatched.join(', ')}`;
          return undefined;
        },
      });

      if (prompts.isCancel(answer)) {
        console.log(pc.dim('\nCancelado.\n'));
        process.exit(0);
      }
      return answer;
    })());

  const { matched, unmatched, duplicates } = resolveSeatCodes(input, free);

  if (unmatched.length > 0) {
    throw new ValidationError(
      'SEATS_UNAVAILABLE',
      `Estas sillas no están disponibles: ${unmatched.join(', ')}. Revisa el mapa con "cine asientos ${showtimeId}".`,
      { unmatched }
    );
  }

  if (duplicates.length > 0) {
    throw new ValidationError(
      'SEATS_DUPLICATED',
      `Repetiste estas sillas: ${duplicates.join(', ')}.`,
      { duplicates }
    );
  }

  if (matched.length === 0) {
    throw new ValidationError('NO_SEATS', 'No seleccionaste ninguna silla.');
  }

  return matched;
}

interface ChosenSeat {
  seat: AvailableSeat;
  type: TicketType;
}

/**
 * Pair each seat with a ticket type.
 *
 * Inferred from the seat's area when unambiguous, since that is what the website
 * does, and asked for otherwise. The API rejects a wrong pairing with 400, so a
 * bad guess fails loudly rather than silently selling the wrong ticket.
 */
async function chooseTicketTypes(
  seats: AvailableSeat[],
  ticketTypes: TicketType[],
  options: ComprarOptions
): Promise<ChosenSeat[]> {
  const selectable = ticketTypes.filter((type) => !type.isRestricted);

  if (selectable.length === 0) {
    throw new ValidationError(
      'NO_TICKET_TYPES',
      'La API no reporta boletas compradas sin promoción para esta función.'
    );
  }

  if (options.boleta) {
    const forced = ticketTypes.find((type) => type.id === options.boleta);
    if (!forced) {
      throw new ValidationError(
        'TICKET_TYPE_NOT_FOUND',
        `No existe el tipo de boleta "${options.boleta}" en esta función. Ver opciones: cine asientos <función> --precios`,
        { available: selectable.map((type) => type.id) }
      );
    }
    return seats.map((seat) => ({ seat, type: forced }));
  }

  // One decision per area, not per seat: asking twice for two seats in the same
  // area would be noise.
  const byArea = new Map<string, TicketType>();

  for (const seat of seats) {
    const area = seat.areaName;
    if (byArea.has(area)) continue;

    const inferred = matchTicketTypeForArea(area, ticketTypes);
    if (inferred) {
      byArea.set(area, inferred);
      continue;
    }

    const answer = await prompts.select({
      message: `Tipo de boleta para ${area}`,
      options: selectable.map((type) => ({
        value: type.id,
        label: `${type.name} — ${formatMoney(type.price)}`,
      })),
    });

    if (prompts.isCancel(answer)) {
      console.log(pc.dim('\nCancelado.\n'));
      process.exit(0);
    }

    const chosen = selectable.find((type) => type.id === answer);
    if (!chosen) throw new ValidationError('TICKET_TYPE_NOT_FOUND', 'Tipo de boleta inválido.');
    byArea.set(area, chosen);
  }

  return seats.map((seat) => {
    const type = byArea.get(seat.areaName);
    if (!type) throw new ValidationError('TICKET_TYPE_NOT_FOUND', 'Tipo de boleta inválido.');
    return { seat, type };
  });
}

function printOrderPreview(selections: ChosenSeat[], total: number): void {
  console.log(`  ${pc.bold('Tu compra')}`);
  for (const { seat, type } of selections) {
    console.log(
      `    ${pc.cyan(seatCode(seat.seat).padEnd(5))} ${pc.dim(seat.areaName.padEnd(13))} ${type.name} ${pc.dim(formatMoney(type.price))}`
    );
  }
  console.log(`    ${pc.dim('─'.repeat(48))}`);
  console.log(`    ${pc.bold(`Subtotal  ${formatMoney(total)}`)}`);
  console.log(
    pc.dim('    Cine Colombia suma un cargo por servicio; el total real lo confirma la orden.\n')
  );
}

/**
 * Buyer details, taken from the signed-in account when possible.
 *
 * Logging in makes this step disappear: the account already holds the name, email
 * and identification number the order needs, so nothing has to be typed or stored
 * by this CLI. Explicit flags still win, and a guest is simply asked.
 */
async function resolveCustomer(options: ComprarOptions): Promise<CustomerDetails> {
  const member = await cineApi.getMember().catch(() => null);

  if (member) {
    const fromAccount: CustomerDetails = {
      givenName: options.nombre ?? member.givenName,
      familyName: options.apellido ?? member.familyName,
      email: options.email ?? member.email ?? '',
      identification: options.cedula ?? member.nationalId ?? '',
      phoneNumber: member.phoneNumber ?? '',
    };

    // Only fall through to prompting for the pieces the account is missing.
    if (fromAccount.email && fromAccount.identification) {
      console.log(
        pc.dim(`  Comprando como ${member.fullName} (${member.email ?? 'sin correo'})\n`)
      );
      return fromAccount;
    }

    return collectCustomer({
      ...options,
      nombre: fromAccount.givenName || undefined,
      apellido: fromAccount.familyName || undefined,
      email: fromAccount.email || undefined,
      cedula: fromAccount.identification || undefined,
    });
  }

  return collectCustomer(options);
}

async function collectCustomer(options: ComprarOptions): Promise<CustomerDetails> {
  const ask = async (
    message: string,
    provided: string | undefined,
    validate: (value: string) => string | undefined
  ): Promise<string> => {
    if (provided !== undefined) {
      const problem = validate(provided);
      if (problem) throw new ValidationError('INVALID_CUSTOMER_DATA', problem, { message });
      return provided.trim();
    }

    const answer = await prompts.text({ message, validate: (value) => validate(value ?? '') });
    if (prompts.isCancel(answer)) {
      console.log(pc.dim('\nCancelado. No se apartó ninguna silla.\n'));
      process.exit(0);
    }
    return answer.trim();
  };

  const required = (label: string) => (value: string) =>
    value.trim() ? undefined : `${label} es obligatorio.`;

  return {
    givenName: await ask('Nombre', options.nombre, required('El nombre')),
    familyName: await ask('Apellido', options.apellido, required('El apellido')),
    email: await ask('Correo electrónico', options.email, (value) =>
      EMAIL_PATTERN.test(value.trim()) ? undefined : 'Escribe un correo válido.'
    ),
    identification: await ask('Número de identificación', options.cedula, (value) =>
      ID_PATTERN.test(value.trim()) ? undefined : 'La cédula debe tener entre 6 y 11 dígitos.'
    ),
  };
}

/**
 * Run the write sequence, cleaning up the seat hold on any failure.
 *
 * The order is only left alive once the payment link exists, because from that
 * point the user is going to pay and cancelling would destroy their purchase.
 */
async function placeOrder(
  showtimeId: string,
  theatreId: string,
  selections: ChosenSeat[],
  customer: CustomerDetails,
  options: ComprarOptions
): Promise<void> {
  const spinner = prompts.spinner();
  spinner.start('Creando la orden');

  const order = await orderService.createOrder(theatreId);
  let handedOffToPayment = false;

  // Ctrl+C between here and the payment link would otherwise strand the seats.
  const releaseOnInterrupt = () => {
    void orderService.cancelOrder(order.id).finally(() => process.exit(130));
  };
  process.once('SIGINT', releaseOnInterrupt);

  try {
    spinner.message('Apartando las sillas');
    const seatSelections: SeatSelection[] = selections.map(({ seat, type }) => ({
      seatId: seat.seat.id,
      ticketTypeId: type.id,
    }));

    const withSeats = await setSeatsExplainingMismatch(order.id, showtimeId, seatSelections);

    spinner.message('Registrando tus datos');
    await orderService.setCustomer(order.id, customer);

    spinner.message('Generando el enlace de pago');
    const payment = await orderService.createPaymentRedirect(order.id);
    handedOffToPayment = true;
    spinner.stop('Orden lista');

    console.log(
      `\n  ${pc.bold('Total a pagar')}  ${pc.green(formatMoney(withSeats.totalPrice.valueIncludingTax))}`
    );
    if (withSeats.bookingFee && withSeats.bookingFee.valueIncludingTax > 0) {
      console.log(
        pc.dim(
          `  Incluye ${formatMoney(withSeats.bookingFee.valueIncludingTax)} de cargo por servicio.`
        )
      );
    }
    console.log(pc.dim(`  Orden ${order.id}`));

    const deadline = payment.expiresAt ?? order.expiresAt;
    if (deadline) {
      console.log(pc.dim(`  Vence ${formatTime(deadline)} — si no pagas, las sillas se liberan.`));
    }

    console.log(`\n  ${pc.bold('Falta pagar en el navegador')}`);
    console.log(
      pc.dim('  El pago lo procesa PlacetoPay. Los datos de tu tarjeta nunca pasan por esta CLI.')
    );
    console.log(`\n  ${pc.cyan(payment.url)}\n`);

    if (!options.sinAbrir) {
      const opened = await openInBrowser(payment.url);
      if (!opened)
        console.log(pc.dim('  No se pudo abrir el navegador: copia el enlace de arriba.\n'));
    }
  } catch (error) {
    spinner.stop('No se pudo completar la orden', 1);
    if (!handedOffToPayment) {
      const released = await orderService.cancelOrder(order.id);
      console.log(
        pc.dim(
          released
            ? '  Se canceló la orden y se liberaron las sillas.'
            : `  No se pudo cancelar la orden ${order.id}; las sillas se liberan solas al vencer.`
        )
      );
    }
    throw error;
  } finally {
    process.off('SIGINT', releaseOnInterrupt);
  }
}

/** Translate the API's 400 for a seat/ticket mismatch into an actionable message. */
async function setSeatsExplainingMismatch(
  orderId: string,
  showtimeId: string,
  selections: SeatSelection[]
) {
  try {
    return await orderService.setSeats(orderId, showtimeId, selections);
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) {
      throw new ValidationError(
        'SEAT_TICKET_MISMATCH',
        'Cine Colombia rechazó la combinación de sillas y boletas. Normalmente es porque el tipo de boleta no corresponde al área de la silla (por ejemplo, boleta General en una silla Preferencial). Elige el tipo con --boleta o deja que la CLI lo infiera.',
        error.details
      );
    }
    throw error;
  }
}

/** Where a human completes this purchase on the website. */
function webCheckoutUrl(showtimeId: string): string {
  return `https://multiplex.cinecolombia.com/order/showtimes/${encodeURIComponent(showtimeId)}/seats`;
}
