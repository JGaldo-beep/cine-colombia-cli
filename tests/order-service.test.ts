import { describe, expect, it } from 'bun:test';
import type { OcapiClient } from '../src/services/api/ocapi-client.js';
import { OrderService } from '../src/services/api/order-service.js';

interface CustomerBody {
  name: { givenName: string; familyName: string };
  email: string;
  phoneNumber: string;
  preferences: { languageTag: string };
  taxDetails: { name: string; number: string };
  deliveryAddress: Record<string, string | object>;
  billingAddress: Record<string, string | object>;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Stand-in for the HTTP client that records calls.
 *
 * These tests pin the exact request shapes observed on the real checkout. If the
 * bodies drift, the live API rejects them, so asserting them here is the contract.
 */
function fakeClient(response: unknown = {}) {
  const calls: Call[] = [];

  const client = {
    send: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return response;
    },
  } as unknown as OcapiClient;

  return { client, calls };
}

const orderEnvelope = {
  order: {
    id: 'abc123',
    status: 'InProgress',
    expiresAt: '2026-07-25T00:30:21Z',
    totalPrice: { valueIncludingTax: 17100, valueExcludingTax: 16845, tax: 255 },
    booking: { totalBookingFee: { valueIncludingTax: 1600, valueExcludingTax: 1345, tax: 255 } },
  },
};

describe('createOrder', () => {
  it('posts the booking body the API requires', async () => {
    const { client, calls } = fakeClient(orderEnvelope);
    await new OrderService(client).createOrder('6493');

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/ocapi/v1/orders/standard/booking');
    expect(calls[0]?.body).toEqual({ siteId: '6493', bookingMode: 'Paid' });
  });

  it('surfaces the order id, expiry and price', async () => {
    const { client } = fakeClient(orderEnvelope);
    const order = await new OrderService(client).createOrder('6493');

    expect(order.id).toBe('abc123');
    expect(order.expiresAt).toBe('2026-07-25T00:30:21Z');
    expect(order.totalPrice.valueIncludingTax).toBe(17100);
    expect(order.bookingFee?.valueIncludingTax).toBe(1600);
  });

  it('reports a null booking fee when the API omits it', async () => {
    const { client } = fakeClient({ order: { ...orderEnvelope.order, booking: undefined } });
    expect((await new OrderService(client).createOrder('6493')).bookingFee).toBeNull();
  });
});

describe('setSeats', () => {
  it('sends seat ids and one ticket per seat', async () => {
    const { client, calls } = fakeClient(orderEnvelope);
    await new OrderService(client).setSeats('abc123', '6493-7850', [
      { seatId: '1_5_1', ticketTypeId: '6493-0001' },
      { seatId: '1_5_2', ticketTypeId: '6493-0001' },
    ]);

    const body = calls[0]?.body as { seats: string[]; tickets: Array<Record<string, string>> };
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe('/ocapi/v1/orders/abc123/showtimes/6493-7850');
    expect(body.seats).toEqual(['1_5_1', '1_5_2']);
    expect(body.tickets).toHaveLength(2);
    expect(body.tickets[0]?.ticketTypeId).toBe('6493-0001');
  });

  it('generates a distinct client-side id for every ticket', async () => {
    const { client, calls } = fakeClient(orderEnvelope);
    await new OrderService(client).setSeats('abc123', '6493-7850', [
      { seatId: '1_5_1', ticketTypeId: '6493-0001' },
      { seatId: '1_5_2', ticketTypeId: '6493-0001' },
    ]);

    const body = calls[0]?.body as { tickets: Array<{ id: string }> };
    const ids = body.tickets.map((ticket) => ticket.id);
    expect(new Set(ids).size).toBe(2);
    // The API adopts whatever UUID we send as the ticket identifier.
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('allows different ticket types per seat, for mixed areas', async () => {
    const { client, calls } = fakeClient(orderEnvelope);
    await new OrderService(client).setSeats('abc123', '6493-7850', [
      { seatId: '1_5_1', ticketTypeId: '6493-0001' },
      { seatId: '2_1_1', ticketTypeId: '6493-0002' },
    ]);

    const body = calls[0]?.body as { tickets: Array<{ ticketTypeId: string }> };
    expect(body.tickets.map((ticket) => ticket.ticketTypeId)).toEqual(['6493-0001', '6493-0002']);
  });
});

describe('setCustomer', () => {
  it('maps the identification number to taxDetails, as the website does', async () => {
    const { client, calls } = fakeClient();
    await new OrderService(client).setCustomer('abc123', {
      givenName: 'Ana',
      familyName: 'Gómez',
      email: 'ana@example.com',
      identification: '1020304050',
    });

    const body = calls[0]?.body as CustomerBody;
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe('/ocapi/v1/orders/abc123/customer');
    expect(body.name).toEqual({ givenName: 'Ana', familyName: 'Gómez' });
    expect(body.taxDetails.number).toBe('1020304050');
    expect(body.preferences.languageTag).toBe('es-419');
  });

  it('sends blank addresses rather than inventing one for a counter pickup', async () => {
    const { client, calls } = fakeClient();
    await new OrderService(client).setCustomer('abc123', {
      givenName: 'Ana',
      familyName: 'Gómez',
      email: 'ana@example.com',
      identification: '1020304050',
    });

    const body = calls[0]?.body as CustomerBody;
    expect(body.deliveryAddress.line1).toBe('');
    expect(body.billingAddress.city).toBe('');
    expect(body.phoneNumber).toBe('');
  });
});

describe('createPaymentRedirect', () => {
  it('requests the card payment method and returns the gateway URL', async () => {
    const { client, calls } = fakeClient({
      redirectUrl: 'https://cineco-wpm.app.vista.co/Request.aspx?token=xyz',
      updatedOrderExpiresAt: '2026-07-25T01:00:12Z',
    });

    const payment = await new OrderService(client).createPaymentRedirect('abc123');

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/ocapi/v1/orders/abc123/payments/redirect');
    expect((calls[0]?.body as { webPaymentMethodId: number }).webPaymentMethodId).toBe(2);
    expect(payment.url).toBe('https://cineco-wpm.app.vista.co/Request.aspx?token=xyz');
    expect(payment.expiresAt).toBe('2026-07-25T01:00:12Z');
  });

  it('tolerates a missing updated expiry', async () => {
    const { client } = fakeClient({ redirectUrl: 'https://pay.example/x' });
    expect((await new OrderService(client).createPaymentRedirect('abc123')).expiresAt).toBeNull();
  });
});

describe('cancelOrder', () => {
  it('deletes the order so the seats are released', async () => {
    const { client, calls } = fakeClient();
    expect(await new OrderService(client).cancelOrder('abc123')).toBe(true);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe('/ocapi/v1/orders/abc123');
  });

  it('reports failure without throwing, because it runs on error paths', async () => {
    // Cancellation runs while another error is already being reported; throwing
    // here would mask the problem the user actually needs to see.
    const client = {
      send: async () => {
        throw new Error('network down');
      },
    } as unknown as OcapiClient;

    expect(await new OrderService(client).cancelOrder('abc123')).toBe(false);
  });

  it('encodes the order id into the path', async () => {
    const { client, calls } = fakeClient();
    await new OrderService(client).cancelOrder('a/b');
    expect(calls[0]?.path).toBe('/ocapi/v1/orders/a%2Fb');
  });
});

describe('extendExpiry', () => {
  it('posts to the expiry reset endpoint', async () => {
    const { client, calls } = fakeClient();
    await new OrderService(client).extendExpiry('abc123');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/ocapi/v1/orders/abc123/expiry/reset');
  });
});
