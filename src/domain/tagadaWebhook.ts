/**
 * tagadaWebhook.ts
 * ────────────────
 * Pure helpers for the TagadaPay webhook: signature verification, event-id
 * derivation (replay protection) and deterministic order-lookup planning.
 */
import crypto from 'crypto';

// ─── Signature (L-9) ──────────────────────────────────────────────────────────

/**
 * Verify a GitHub-style `sha256=<hex>` (or bare hex) HMAC-SHA256 signature of
 * the raw body. Constant-time compare on equal-length buffers; never throws.
 */
export function verifyTagadaSignature(
  rawBody: Buffer | string,
  signatureHeader: string | string[] | undefined,
  secret: string
): boolean {
  if (!secret || !signatureHeader) return false;
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (typeof header !== 'string') return false;
  const received = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  if (!/^[0-9a-fA-F]+$/.test(received)) return false;

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(received.toLowerCase(), 'utf8');
  const b = Buffer.from(expectedHex, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Event id (H-5) ───────────────────────────────────────────────────────────

const EVENT_ID_HEADERS = [
  'x-tagadapay-event-id',
  'x-tagadapay-delivery-id',
  'x-tagadapay-webhook-id',
  'x-tagada-event-id',
  'webhook-id',
];

/**
 * The SDK types (types/webhooks.d.ts, types/events.d.ts) define no event id on
 * the webhook body and no delivery header. We therefore use an explicit event id
 * if one is ever present (header or `eventId`/`event_id`/`webhookEventId`), and
 * otherwise the SHA-256 of the raw body — an identical redelivery is a
 * duplicate. We deliberately do NOT use `payload.id`/`data.id`: that is the
 * payment id, shared by payment/created, payment/succeeded, payment/refunded…
 */
export function deriveWebhookEventId(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  payload: any
): { eventId: string; source: 'header' | 'payload' | 'body_sha256' } {
  for (const h of EVENT_ID_HEADERS) {
    const v = headers[h];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s.trim()) return { eventId: s.trim().slice(0, 200), source: 'header' };
  }
  const fromPayload = payload?.eventId ?? payload?.event_id ?? payload?.webhookEventId ?? payload?.appEventId;
  if (typeof fromPayload === 'string' && fromPayload.trim()) {
    return { eventId: fromPayload.trim().slice(0, 200), source: 'payload' };
  }
  const hash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return { eventId: `sha256:${hash}`, source: 'body_sha256' };
}

// ─── Order lookup (H-7) ───────────────────────────────────────────────────────

export const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

export function isObjectIdString(v: unknown): v is string {
  return typeof v === 'string' && OBJECT_ID_RE.test(v);
}

/** A provider id is usable only if it is a non-empty string and not 'unknown'. */
export function isUsableExternalId(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s.length > 0 && s.toLowerCase() !== 'unknown' && s !== 'null' && s !== 'undefined';
}

export type OrderLookupPlan =
  | { kind: 'byId'; orderId: string; fallbackClauses: Array<Record<string, string>> }
  | { kind: 'byExternal'; clauses: Array<Record<string, string>> }
  | { kind: 'conflict'; reason: string }
  | { kind: 'none' };

/**
 * Build a deterministic lookup plan from a webhook payload.
 * 1) our own Order _id from cartToken / externalOrderId / metadata.order_id / reference
 *    (if several are present they must agree, otherwise → conflict)
 * 2) else exact match on tagadaSessionId / tagadaOrderId / tagadaPaymentId /
 *    tagadaProviderPaymentId — a clause is only emitted for a usable string;
 *    never `{field: undefined}`.
 */
export function buildOrderLookupPlan(payload: any): OrderLookupPlan {
  const d = payload?.data && typeof payload.data === 'object' ? payload.data : payload ?? {};

  const idCandidates = [
    d.cartToken,
    d.externalOrderId,
    d.metadata?.order_id,
    payload?.metadata?.order_id,
    d.reference,
  ].filter(isObjectIdString);
  const distinctIds = Array.from(new Set(idCandidates.map((s: string) => s.toLowerCase())));

  const clauses: Array<Record<string, string>> = [];
  const add = (field: string, v: unknown) => {
    if (isUsableExternalId(v)) {
      const val = v.trim();
      if (!clauses.some((c) => c[field] === val)) clauses.push({ [field]: val });
    }
  };
  const sessionId = d.checkoutSessionId ?? d.sessionId ?? d.session_id;
  add('tagadaPaymentId', d.checkoutSessionId);
  add('tagadaSessionId', sessionId);
  add('tagadaPaymentId', sessionId);
  add('tagadaOrderId', d.orderId ?? d.order_id);
  add('tagadaProviderPaymentId', d.paymentId);
  add('tagadaPaymentId', d.paymentId);

  if (distinctIds.length > 1) {
    return { kind: 'conflict', reason: `Webhook references multiple order ids: ${distinctIds.join(', ')}` };
  }
  if (distinctIds.length === 1) return { kind: 'byId', orderId: idCandidates[0], fallbackClauses: clauses };
  if (clauses.length > 0) return { kind: 'byExternal', clauses };
  return { kind: 'none' };
}

/** Resolve candidates found by the external-id query: exactly one, or refuse. */
export function resolveSingleCandidate<T extends { _id: unknown }>(
  candidates: T[]
): { kind: 'found'; order: T } | { kind: 'ambiguous'; ids: string[] } | { kind: 'none' } {
  const unique = new Map<string, T>();
  for (const c of candidates) unique.set(String(c._id), c);
  if (unique.size === 0) return { kind: 'none' };
  if (unique.size > 1) return { kind: 'ambiguous', ids: Array.from(unique.keys()) };
  return { kind: 'found', order: unique.values().next().value as T };
}
