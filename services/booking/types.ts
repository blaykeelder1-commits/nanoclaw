// Shared types for the Sheridan Rentals Booking API

export type EquipmentKey = 'rv' | 'carhauler' | 'landscaping';

export interface EquipmentConfig {
  key: EquipmentKey;
  label: string;
  rate: number;
  unit: 'night' | 'day';
  deposit: number;
  calendarId: string;
}

export interface AddOn {
  key: string;
  label: string;
  rate: number;
  unit: 'night' | 'day' | 'flat';
  appliesTo: EquipmentKey[];
}

export interface LineItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** 'full' = charge everything now, 'deposit' = charge deposit only (balance due before rental) */
export type PaymentMode = 'full' | 'deposit';

export interface PriceBreakdown {
  equipment: EquipmentConfig;
  numDays: number;
  lineItems: LineItem[];
  /** Rental + add-ons, NET of any promo discount (already reflected in lineItems). */
  subtotal: number;
  deposit: number;
  balance: number;
  addOns: string[];
  /** Promo discount applied to the rental subtotal (not the deposit), if any. */
  discount?: { label: string; amount: number };
  /** What the customer pays at checkout — full amount or deposit only */
  paymentMode: PaymentMode;
  /** Amount charged to Square right now */
  chargeNow: number;
}

export interface Customer {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface CheckoutRequest {
  equipment: EquipmentKey;
  dates: string[];       // YYYY-MM-DD sorted
  customer: Customer;
  addOns?: string[];     // ['generator', 'delivery']
  details?: string;
  timeSlot?: string;
  paymentMode?: PaymentMode;
  /** Owner-distributed promo code (e.g. "RIVER" for RV self-tow). */
  promoCode?: string;
  /** File ID of a previously-uploaded license photo from /api/upload. */
  licenseFileId?: string;
  /** Session ID used during the license upload (must match /api/upload response). */
  sessionId?: string;
  /** Destination / delivery address for the camper. Required for RV unless RIVER promo is active. */
  deliveryAddress?: string;
  /** GA4 client_id (from the _ga cookie) for server-side conversion attribution. */
  gaClientId?: string;
  /** Google Ads click id for offline conversion import. */
  gclid?: string;
  /** UTM/attribution blob the form collects; may carry gclid. */
  attribution?: { gclid?: string; [k: string]: unknown };
}

export interface CheckoutResponse {
  bookingId: string;
  paymentUrl: string;
  orderId: string;
  pricing: PriceBreakdown;
}

export type BookingStatus = 'pending' | 'paid' | 'confirmed' | 'cancelled' | 'refunded';

export interface Booking {
  id: string;
  equipment: EquipmentKey;
  equipmentLabel: string;
  dates: string[];       // JSON-stored array of YYYY-MM-DD
  numDays: number;
  customer: Customer;
  subtotal: number;
  deposit: number;
  balance: number;
  addOns: string[];      // JSON-stored array
  details: string;
  status: BookingStatus;
  squareOrderId: string;
  squarePaymentLinkId: string;
  paymentUrl: string;
  calendarEventId: string;
  refundId: string;
  followupSent: boolean;
  followupSentAt: string | null;
  /** File ID of the license photo on disk (empty string if none uploaded). */
  licenseFileId: string;
  /** Destination address for the camper (empty string if pickup via RIVER promo). */
  deliveryAddress: string;
  /** Pickup time slot 'HH:MM' (24h) for car hauler / utility pickups; also the drop-off due time. Empty for RV (delivered). */
  pickupTime: string;
  /** True when Andy created the booking from a chat conversation (license deferred to post-payment SMS). */
  agentInitiated: boolean;
  /** Timestamp the post-payment license-upload SMS went out, or '' if never sent. */
  licenseSmsSentAt: string;
  /** AG-XXXXXXXXXXXXXXXX id of the signed rental agreement, or '' if not signed yet. */
  agreementId: string;
  /** Unguessable token used in the /sign/:bookingId/:signToken URL (Andy's flow). */
  signToken: string;
  /** Timestamp the agent sent the sign-agreement SMS, or '' if never sent. */
  agreementSmsSentAt: string;
  /** JSON snapshot of the pricing object used at booking time. Lets the agent-payment-link
   *  endpoint recreate the Square payment link without re-validating dates / promo codes. */
  pricingSnapshot: string;
  /** Device parsed from the checkout User-Agent: 'mobile' | 'tablet' | 'desktop' | ''. Ground-truth device split. */
  device: string;
  /** GA4 client_id (from the _ga cookie) captured at checkout, for server-side conversion attribution. */
  gaClientId: string;
  /** Google Ads click id captured at checkout, for offline conversion import. */
  gclid: string;
  /** Timestamp the server-side conversion was sent to GA4/Ads, or '' if not yet sent (double-fire guard). */
  conversionSentAt: string;
  createdAt: string;
  updatedAt: string;
}

// ── Rental Agreement ────────────────────────────────────────────────

export type AgreementKind = 'sheridan-rv' | 'sheridan-hauler' | 'sheridan-landscaping';

export interface Agreement {
  id: string;
  /** Empty for pre-booking (web-form) rows until /api/checkout links them. */
  bookingId: string;
  /** One-time token used by web form to bind sign step → checkout. Empty for Andy-flow rows. */
  agreementToken: string;
  kind: AgreementKind;
  version: string;
  contentHash: string;
  signerName: string;
  signerEmail: string;
  /** Base64 dataURL of the canvas signature. */
  signaturePng: string;
  signerIp: string;
  signerUa: string;
  signedAt: string;
}

export interface AgreementContext {
  bookingId: string;
  equipmentLabel: string;
  customerName: string;
  customerEmail: string;
  dates: string[];
  numDays: number;
  unit: 'night' | 'day';
  deposit: number;
  total: number;
  deliveryAddress: string;
  hasDelivery: boolean;
}

export interface AgentCheckoutRequest {
  equipment: EquipmentKey;
  dates: string[];
  customer: Customer;
  addOns?: string[];
  details?: string;
  paymentMode?: PaymentMode;
  promoCode?: string;
  deliveryAddress?: string;
}

export interface AgentCheckoutResponse {
  bookingId: string;
  paymentUrl: string;
  orderId: string;
  licenseUploadUrl: string;
  pricing: PriceBreakdown;
}

export interface AvailabilityRequest {
  equipment: EquipmentKey;
  startDate: string;     // YYYY-MM-DD
  endDate: string;       // YYYY-MM-DD
}

export interface BusySlot {
  start: string;
  end: string;
}

export interface AvailabilityResponse {
  equipment: EquipmentKey;
  busySlots: BusySlot[];
  startDate: string;
  endDate: string;
}
