import Customer from '../../models/Customer';

/** Shown to a banned customer at checkout (deliberately neutral: no reason is given). */
export const BANNED_CUSTOMER_MESSAGE = 'We are unable to accept this order. Please contact us if you think this is a mistake.';

/**
 * True when the email belongs to a customer an admin banned (Customers → Ban customer).
 * Customer emails are stored lowercased. A lookup failure never blocks a checkout.
 */
export async function isBannedCustomerEmail(email: unknown): Promise<boolean> {
  if (typeof email !== 'string' || !email.trim()) return false;
  try {
    const hit = await Customer.exists({ email: email.trim().toLowerCase(), banned: true });
    return !!hit;
  } catch (err: any) {
    console.error(`[Checkout] Banned-customer check failed: ${err?.message}`);
    return false;
  }
}
