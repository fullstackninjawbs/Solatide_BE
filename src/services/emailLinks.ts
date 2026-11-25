/**
 * Links to the storefront inside customer emails carry UTM tags, so a visit that starts from an
 * email shows as source "Email" in analytics (instead of "Direct"), with the email type as the
 * campaign (payment_details, order_confirmation, shipping, ...). Existing query parameters (e.g.
 * an order's accessToken) are kept. A URL that can't be parsed is returned unchanged.
 */
export type EmailCampaign =
  | 'payment_details'
  | 'payment_reminder'
  | 'order_confirmation'
  | 'shipping'
  | 'newsletter_welcome'
  | 'abandoned_checkout';

export function emailLink(url: string, campaign: EmailCampaign): string {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', 'solatide');
    u.searchParams.set('utm_medium', 'email');
    u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch {
    return url;
  }
}
