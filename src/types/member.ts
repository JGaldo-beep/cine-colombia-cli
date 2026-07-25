// Account and concessions types.

import type { LocalizedText } from './cine.js';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export interface RawMember {
  id: string;
  membershipStartDate: string | null;
  credentials: { username: string | null; email: string | null };
  clubMembership: { clubId: number | null; clubLevelId: number | null } | null;
  personalDetails: {
    name: { givenName: string | null; familyName: string | null; middleName: string | null };
    contactDetails: {
      phoneNumbers: Array<{ type: string; number: string }>;
    } | null;
    /** Colombian identification number, which the order API expects as the tax id. */
    nationalId: string | null;
    birthDate: string | null;
  } | null;
}

export interface MemberResponse {
  member: RawMember;
}

export interface MemberOrdersResponse {
  orders: Array<{
    id: string;
    bookingId?: string | null;
    totalPrice?: { valueIncludingTax: number };
    showtimes?: Array<{ showtimeId: string; tickets?: unknown[] }>;
  }>;
  relatedData?: {
    showtimes?: Array<{
      id: string;
      filmId: string;
      siteId: string;
      schedule?: { startsAt: string };
    }>;
    films?: Array<{ id: string; title: LocalizedText }>;
    sites?: Array<{ id: string; name: LocalizedText }>;
  };
}

export interface RawItem {
  id: string;
  name: LocalizedText;
  description: LocalizedText | null;
}

export interface ItemProfileResponse {
  itemProfile: {
    siteId: string;
    pages: Array<{
      number: number;
      title: LocalizedText | null;
      displayPriority: number | null;
      buttons: Array<{
        itemId: string;
        title: LocalizedText | null;
        displayPriority: number | null;
        prices: Array<{
          price: { valueIncludingTax: number };
          isDefault: boolean;
          restrictions: string[];
        }>;
      }>;
    }>;
  };
  relatedData?: { items?: RawItem[] };
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** The signed-in account holder. */
export interface Member {
  id: string;
  email: string | null;
  fullName: string;
  givenName: string;
  familyName: string;
  /** Identification number, used to prefill the buyer details on an order. */
  nationalId: string | null;
  phoneNumber: string | null;
  clubLevelId: number | null;
  memberSince: string | null;
}

/** A ticket already bought and not yet used. */
export interface MemberOrder {
  id: string;
  total: number | null;
  filmTitle: string | null;
  theatreName: string | null;
  startsAt: string | null;
  ticketCount: number;
}

/** One item on the concessions menu. */
export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  /** True when it needs a voucher or promotion, so it cannot simply be bought. */
  isRestricted: boolean;
}

/** A menu section as the theatre groups it, e.g. "Confiteria". */
export interface MenuSection {
  name: string;
  items: MenuItem[];
}
