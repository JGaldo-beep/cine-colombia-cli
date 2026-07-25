// Order lifecycle against Vista OCAPI.
//
// Every request shape here was derived by recording the real checkout on
// multiplex.cinecolombia.com. The sequence is:
//
//   1. POST /orders/standard/booking              create an empty order
//   2. PUT  /orders/{id}/showtimes/{showtimeId}   attach seats and tickets
//   3. PUT  /orders/{id}/customer                 buyer details (guest is fine)
//   4. POST /orders/{id}/payments/redirect        get the payment gateway URL
//
// Creating an order immediately holds the chosen seats for about five minutes, so
// step 1 has real consequences for other customers. Callers must confirm with the
// user before starting, and must `cancelOrder` on any failure or abort.
//
// Payment itself is never handled here. Cine Colombia redirects to PlacetoPay, a
// hosted PCI gateway that fingerprints the device precisely to detect automation.
// The card is entered by the human in a browser; this module only produces the URL.

import { randomUUID } from 'node:crypto';
import type { OcapiClient } from './ocapi-client.js';
import { cineApi } from './ocapi-client.js';

/** Payment method id for "Tarjeta de Débito / Crédito" (the PlacetoPay redirect). */
export const CARD_PAYMENT_METHOD_ID = 2;

/** Where PlacetoPay sends the browser back after payment. */
const RETURN_URL = 'https://multiplex.cinecolombia.com/order/payment?deliveryMode=Pickup';

const LANGUAGE_TAG = 'es-419';

export interface Money {
  valueIncludingTax: number;
  valueExcludingTax: number;
  tax: number;
}

export interface OrderSummary {
  id: string;
  status: string;
  /** When the seat hold lapses and the order is discarded, as an ISO timestamp. */
  expiresAt: string;
  totalPrice: Money;
  /** Service fee already included in `totalPrice`. */
  bookingFee: Money | null;
}

export interface CustomerDetails {
  givenName: string;
  familyName: string;
  email: string;
  /** Colombian identification number, sent as the tax id. */
  identification: string;
  phoneNumber?: string;
}

/** One seat paired with the ticket category it is being sold under. */
export interface SeatSelection {
  seatId: string;
  ticketTypeId: string;
}

interface RawOrderEnvelope {
  order: {
    id: string;
    status: string;
    expiresAt: string;
    totalPrice: Money;
    booking?: { totalBookingFee?: Money };
  };
}

export class OrderService {
  constructor(private api: OcapiClient = cineApi) {}

  /**
   * Create an empty paid order at a theatre.
   *
   * Nothing is held yet: seats are only reserved once `setSeats` runs. The order
   * still expires on its own, so an abandoned order costs nobody anything.
   */
  async createOrder(theatreId: string): Promise<OrderSummary> {
    const response = await this.api.send<RawOrderEnvelope>(
      'POST',
      '/ocapi/v1/orders/standard/booking',
      {
        siteId: theatreId,
        bookingMode: 'Paid',
      }
    );

    return toOrderSummary(response);
  }

  /**
   * Attach seats and their ticket types to the order. This is what holds the seats.
   *
   * Each ticket needs a client-generated id; the API adopts whatever UUID we send
   * and uses it to identify the ticket in the resulting order.
   */
  async setSeats(
    orderId: string,
    showtimeId: string,
    selections: SeatSelection[]
  ): Promise<OrderSummary> {
    const response = await this.api.send<RawOrderEnvelope>(
      'PUT',
      `/ocapi/v1/orders/${encodeURIComponent(orderId)}/showtimes/${encodeURIComponent(showtimeId)}`,
      {
        seats: selections.map((selection) => selection.seatId),
        tickets: selections.map((selection) => ({
          id: randomUUID(),
          ticketTypeId: selection.ticketTypeId,
        })),
      }
    );

    return toOrderSummary(response);
  }

  /**
   * Set the buyer's details.
   *
   * Guest checkout is fully supported, which is why this CLI never asks anyone to
   * log in. The address blocks are required by the schema but may be blank for a
   * counter pickup, so they are sent empty rather than invented.
   */
  async setCustomer(orderId: string, customer: CustomerDetails): Promise<void> {
    const emptyAddress = {
      name: { givenName: '', familyName: '' },
      companyName: '',
      phoneNumber: '',
      line1: '',
      suburb: '',
      city: '',
      state: '',
      postCode: '',
      country: '',
    };

    await this.api.send<void>('PUT', `/ocapi/v1/orders/${encodeURIComponent(orderId)}/customer`, {
      name: { givenName: customer.givenName, familyName: customer.familyName },
      email: customer.email,
      phoneNumber: customer.phoneNumber ?? '',
      preferences: { languageTag: LANGUAGE_TAG },
      taxDetails: { name: '', number: customer.identification },
      deliveryAddress: emptyAddress,
      billingAddress: emptyAddress,
    });
  }

  /**
   * Ask OCAPI for a payment session and return where the buyer must go to pay.
   *
   * The returned URL is a one-shot gateway session tied to this order. Also
   * extends the order's expiry, which the response reports.
   */
  async createPaymentRedirect(orderId: string): Promise<{ url: string; expiresAt: string | null }> {
    const response = await this.api.send<{
      redirectUrl: string;
      updatedOrderExpiresAt?: string;
    }>('POST', `/ocapi/v1/orders/${encodeURIComponent(orderId)}/payments/redirect`, {
      webPaymentMethodId: CARD_PAYMENT_METHOD_ID,
      redirectReturnUrl: RETURN_URL,
      languageTag: LANGUAGE_TAG,
    });

    return { url: response.redirectUrl, expiresAt: response.updatedOrderExpiresAt ?? null };
  }

  /** Push back the expiry so a slow buyer does not lose their seats. */
  async extendExpiry(orderId: string): Promise<void> {
    await this.api.send<unknown>(
      'POST',
      `/ocapi/v1/orders/${encodeURIComponent(orderId)}/expiry/reset`
    );
  }

  /**
   * Discard the order and release its seats immediately.
   *
   * Always safe to call, and deliberately silent on failure: it runs on abort and
   * error paths where the original problem is what the user needs to hear about.
   * Without this the seats stay blocked for other customers until expiry.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.api.send<void>('DELETE', `/ocapi/v1/orders/${encodeURIComponent(orderId)}`);
      return true;
    } catch {
      return false;
    }
  }
}

function toOrderSummary(response: RawOrderEnvelope): OrderSummary {
  const order = response.order;
  return {
    id: order.id,
    status: order.status,
    expiresAt: order.expiresAt,
    totalPrice: order.totalPrice,
    bookingFee: order.booking?.totalBookingFee ?? null,
  };
}

export const orderService = new OrderService();
