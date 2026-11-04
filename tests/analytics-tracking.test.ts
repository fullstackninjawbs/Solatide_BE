import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserAgent } from '../src/services/analytics/device';
import { classifyTrafficSource } from '../src/services/analytics/trafficSource';
import { validateCollectBatch, CollectInputError, MAX_EVENTS_PER_BATCH } from '../src/services/analytics/collect';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 325.0.0.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36',
};

test('device: phones, tablets, desktops, in-app browsers', () => {
  assert.deepEqual(parseUserAgent(UA.iphone), { type: 'mobile', label: 'iPhone', os: 'iOS', browser: 'Safari' });
  assert.equal(parseUserAgent(UA.iphoneInstagram).browser, 'Instagram app');
  assert.deepEqual(parseUserAgent(UA.androidChrome), { type: 'mobile', label: 'Android phone', os: 'Android', browser: 'Chrome' });
  assert.equal(parseUserAgent(UA.androidTablet).label, 'Android tablet');
  assert.equal(parseUserAgent(UA.ipad).label, 'iPad');
  assert.deepEqual(parseUserAgent(UA.macSafari), { type: 'desktop', label: 'Desktop', os: 'macOS', browser: 'Safari' });
  // iPadOS pretends to be a Mac; the storefront's touch hint corrects it
  assert.deepEqual(parseUserAgent(UA.macSafari, { touch: true }), { type: 'tablet', label: 'iPad', os: 'iOS', browser: 'Safari' });
  assert.deepEqual(parseUserAgent(UA.winEdge), { type: 'desktop', label: 'Desktop', os: 'Windows', browser: 'Edge' });
  assert.equal(parseUserAgent(UA.samsung).browser, 'Samsung Internet');
  assert.equal(parseUserAgent(undefined).label, 'Desktop');
});

test('traffic source: ads, UTMs, referrers, direct', () => {
  const site = ['solatidebiosciences.com.au'];
  const c = (i: any) => classifyTrafficSource(i, site);
  assert.equal(c({ gclid: 'abc' }).source, 'Google Ads');
  assert.equal(c({ utmSource: 'instagram', utmMedium: 'paid_social', utmCampaign: 'Spring' }).source, 'Instagram Ads');
  assert.equal(c({ utmSource: 'instagram', utmMedium: 'paid_social', utmCampaign: 'Spring' }).campaign, 'Spring');
  assert.equal(c({ fbclid: 'x', utmMedium: 'cpc', utmSource: 'facebook' }).source, 'Facebook Ads');
  assert.equal(c({ ttclid: 'x' }).source, 'TikTok Ads');
  assert.equal(c({ utmSource: 'instagram', utmMedium: 'social' }).source, 'Instagram Organic');
  assert.equal(c({ utmSource: 'newsletter', utmMedium: 'email' }).channel, 'email');
  assert.equal(c({ utmSource: 'pepfinder' }).source, 'pepfinder');
  assert.deepEqual(c({ referrer: 'https://www.google.com.au/' }), { source: 'Google Organic', channel: 'organic_search', referrerDomain: 'google.com.au' });
  assert.equal(c({ referrer: 'https://l.instagram.com/?u=x' }).source, 'Instagram Organic');
  assert.equal(c({ referrer: 'https://chatgpt.com/' }).channel, 'ai');
  assert.equal(c({ referrer: 'https://pepfinder.com/suppliers/solatide-biosciences' }).source, 'pepfinder.com');
  assert.equal(c({ fbclid: 'x' }).channel, 'organic_social');
  // Own site / no referrer = Direct
  assert.equal(c({ referrer: 'https://solatidebiosciences.com.au/collections/all' }).source, 'Direct');
  assert.equal(c({}).source, 'Direct');
});

const ids = { visitorId: 'v_1234567890abcdef', sessionId: 's_1234567890abcdef' };
const ev = (over: any = {}) => ({ id: `e_${Math.random().toString(36).slice(2, 12)}`, type: 'page_view', path: '/', ...over });
const rejects = (body: any, re: RegExp) =>
  assert.throws(() => validateCollectBatch(body), (e: any) => e instanceof CollectInputError && re.test(e.message));

test('collect: valid batch is normalised', () => {
  const b = validateCollectBatch({
    ...ids,
    context: { landingPage: '/products/bpc', referrer: 'https://google.com/', utm: { source: 'google', medium: 'cpc' }, clickIds: { gclid: 'g1' }, touch: true },
    events: [
      ev({ type: 'product_view', path: '/products/bpc', productId: 'a'.repeat(24), productName: 'BPC-157', productImage: 'https://res.cloudinary.com/x/y.png', ageMs: 16 * 60 * 1000 }),
      ev({ type: 'add_to_cart', cart: { items: [{ name: 'BPC-157', quantity: 2, unitPrice: 99.5 }, { name: '', quantity: 1 }] } }),
      ev({ type: 'checkout_step', checkoutId: 'c_1234567890abcdef', stage: 'information', contact: { email: ' Jane@Example.com ', firstName: 'Jane', country: 'au' } }),
    ],
  });
  assert.equal(b.context.clickIds.gclid, 'g1');
  assert.equal(b.events[0].ageMs, 0, 'age outside 0–15 min is ignored');
  assert.deepEqual(b.events[1].cart, { items: [{ productId: undefined, variantId: undefined, name: 'BPC-157', variantTitle: undefined, image: undefined, path: undefined, quantity: 2, unitPrice: 99.5 }], itemCount: 2, value: 199 });
  assert.deepEqual(b.events[2].contact, { email: 'jane@example.com', firstName: 'Jane', lastName: undefined, country: 'AU' });
});

test('collect: duplicates inside one batch are dropped; unsafe values are not stored', () => {
  const same = ev();
  const b = validateCollectBatch({ ...ids, events: [same, same, ev({ productImage: 'javascript:alert(1)', path: 'https://evil.example' })] });
  assert.equal(b.events.length, 2);
  assert.equal(b.events[1].productImage, undefined);
  assert.equal(b.events[1].path, undefined);
});

test('collect: malformed batches are rejected', () => {
  rejects(null, /Invalid body/);
  rejects({ sessionId: ids.sessionId, events: [] }, /required/);
  rejects({ ...ids, visitorId: 'short' }, /required/);
  rejects({ ...ids, events: [ev({ type: 'purchase' })] }, /Invalid event type/);
  rejects({ ...ids, events: [ev({ type: 'order_placed' })] }, /Invalid event type/);
  rejects({ ...ids, events: [ev({ id: 'x' })] }, /Invalid event id/);
  rejects({ ...ids, events: [ev({ type: 'begin_checkout' })] }, /checkoutId is required/);
  rejects({ ...ids, events: Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ev()) }, /At most/);
  // A ping without events is valid
  assert.equal(validateCollectBatch({ ...ids, ping: true }).ping, true);
});
