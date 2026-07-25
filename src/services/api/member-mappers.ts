// Mappers for account and concessions payloads.

import type {
  ItemProfileResponse,
  Member,
  MemberOrder,
  MemberOrdersResponse,
  MenuSection,
  RawMember,
} from '../../types/member.js';

export function toMember(raw: RawMember): Member {
  const name = raw.personalDetails?.name;
  const givenName = name?.givenName?.trim() ?? '';
  const familyName = name?.familyName?.trim() ?? '';

  return {
    id: raw.id,
    email: raw.credentials?.email ?? null,
    fullName: [givenName, familyName].filter(Boolean).join(' ') || raw.id,
    givenName,
    familyName,
    nationalId: raw.personalDetails?.nationalId?.trim() || null,
    phoneNumber: raw.personalDetails?.contactDetails?.phoneNumbers?.[0]?.number ?? null,
    clubLevelId: raw.clubMembership?.clubLevelId ?? null,
    memberSince: raw.membershipStartDate ?? null,
  };
}

/**
 * Flatten the member's active orders, resolving ids against `relatedData`.
 *
 * Film, theatre and schedule live in the lookup tables rather than on the order,
 * so an order whose references are missing still renders with nulls instead of
 * failing the whole listing.
 */
export function toMemberOrders(response: MemberOrdersResponse): MemberOrder[] {
  const showtimes = new Map((response.relatedData?.showtimes ?? []).map((s) => [s.id, s]));
  const films = new Map((response.relatedData?.films ?? []).map((f) => [f.id, f]));
  const sites = new Map((response.relatedData?.sites ?? []).map((s) => [s.id, s]));

  return (response.orders ?? []).map((order) => {
    const first = order.showtimes?.[0];
    const showtime = first ? showtimes.get(first.showtimeId) : undefined;

    return {
      id: order.id,
      total: order.totalPrice?.valueIncludingTax ?? null,
      filmTitle: showtime ? (films.get(showtime.filmId)?.title?.text ?? null) : null,
      theatreName: showtime ? (sites.get(showtime.siteId)?.name?.text ?? null) : null,
      startsAt: showtime?.schedule?.startsAt ?? null,
      ticketCount: (order.showtimes ?? []).reduce(
        (sum, entry) => sum + (entry.tickets?.length ?? 0),
        0
      ),
    };
  });
}

/**
 * Build the menu from the theatre's own page layout.
 *
 * Prices come from the page buttons and names from `relatedData.items`, so both
 * have to be joined. Sections keep the venue's own titles and ordering, which is
 * why "Sushi" and "Confiteria" arrive already separated.
 */
export function toMenuSections(response: ItemProfileResponse): MenuSection[] {
  const names = new Map((response.relatedData?.items ?? []).map((item) => [item.id, item]));

  return (response.itemProfile?.pages ?? [])
    .slice()
    .sort((a, b) => (a.displayPriority ?? 0) - (b.displayPriority ?? 0) || a.number - b.number)
    .map((page) => ({
      name: page.title?.text?.trim() || `Sección ${page.number}`,
      items: (page.buttons ?? [])
        .map((button) => {
          const item = names.get(button.itemId);
          // Prefer the default price; some items list promotional variants too.
          const price = button.prices?.find((entry) => entry.isDefault) ?? button.prices?.[0];

          return {
            id: button.itemId,
            name: item?.name?.text ?? button.title?.text ?? button.itemId,
            description: item?.description?.text?.trim() || null,
            price: price?.price?.valueIncludingTax ?? 0,
            isRestricted: (price?.restrictions?.length ?? 0) > 0,
          };
        })
        .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name)),
    }))
    .filter((section) => section.items.length > 0);
}
