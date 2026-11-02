import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHomepageInput, mergeHomepage, ContentInputError, HOMEPAGE_DEFAULTS } from '../src/services/content/siteContent';

const CLOUD = 'demo';
const img = (w = 1600, h = 900) => ({ url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/homepage/hero.webp`, width: w, height: h });
const valid = () => ({
  hero: { headline: 'Line one\nLine two', subtext: 'Some text', imageAlt: 'Vials', desktopImage: img(), mobileImage: null },
  announcement: { enabled: true, messages: [{ text: 'Free shipping over $300', icon: 'none' }, { text: 'Australian owned', icon: 'au_flag' }] },
});
const rejects = (body: any, re: RegExp) =>
  assert.throws(() => validateHomepageInput(body, CLOUD), (e: any) => e instanceof ContentInputError && re.test(e.message));

test('valid homepage input is accepted and normalised', () => {
  const body = valid();
  body.hero.headline = '  Line one\r\n\r\nLine two  ';
  body.hero.subtext = 'Para\ngraph';
  const out = validateHomepageInput(body, CLOUD);
  assert.equal(out.hero.headline, 'Line one\nLine two');
  assert.equal(out.hero.subtext, 'Para graph');
  assert.deepEqual(out.hero.desktopImage, img());
  assert.equal(out.hero.mobileImage, null);
  assert.equal(out.announcement.messages.length, 2);
});

test('required fields, lengths and line count', () => {
  rejects({ ...valid(), hero: { ...valid().hero, headline: '  ' } }, /Headline is required/);
  rejects({ ...valid(), hero: { ...valid().hero, headline: 'x'.repeat(121) } }, /at most 120/);
  rejects({ ...valid(), hero: { ...valid().hero, headline: 'a\nb\nc\nd' } }, /at most 3 lines/);
  rejects({ ...valid(), hero: { ...valid().hero, subtext: '' } }, /Paragraph is required/);
  rejects({ ...valid(), hero: { ...valid().hero, headline: 123 } }, /must be text/);
});

test('announcement messages: 1–4, text required, known icons only', () => {
  rejects({ ...valid(), announcement: { enabled: true, messages: [] } }, /at least one/);
  rejects({ ...valid(), announcement: { enabled: true, messages: Array(5).fill({ text: 'x', icon: 'none' }) } }, /At most 4/);
  rejects({ ...valid(), announcement: { enabled: true, messages: [{ text: '', icon: 'none' }] } }, /Message 1 is required/);
  rejects({ ...valid(), announcement: { enabled: true, messages: [{ text: 'x', icon: 'rocket' }] } }, /unknown icon/);
  const off = validateHomepageInput({ ...valid(), announcement: { enabled: false, messages: [{ text: 'x' }] } }, CLOUD);
  assert.equal(off.announcement.enabled, false);
  assert.equal(off.announcement.messages[0].icon, 'none');
});

test('images must be our own Cloudinary uploads with a size', () => {
  rejects({ ...valid(), hero: { ...valid().hero, desktopImage: { url: 'https://evil.example/x.png', width: 1, height: 1 } } }, /upload the image through the Hub/);
  rejects({ ...valid(), hero: { ...valid().hero, desktopImage: { url: 'https://res.cloudinary.com/other/image/upload/x.png', width: 1, height: 1 } } }, /through the Hub/);
  rejects({ ...valid(), hero: { ...valid().hero, desktopImage: { url: img().url + '" onerror="x', width: 1, height: 1 } } }, /through the Hub/);
  rejects({ ...valid(), hero: { ...valid().hero, mobileImage: { url: img().url, width: 0, height: 900 } } }, /size is missing/);
});

test('nothing saved → built-in defaults; saved values override them', () => {
  assert.deepEqual(mergeHomepage(null), HOMEPAGE_DEFAULTS);
  const m = mergeHomepage({ hero: { headline: 'New', desktopImage: img() }, announcement: { enabled: false, messages: [{ text: 'Hi', icon: 'card_logos' }] } });
  assert.equal(m.hero.headline, 'New');
  assert.equal(m.hero.subtext, HOMEPAGE_DEFAULTS.hero.subtext);
  assert.deepEqual(m.hero.desktopImage, img());
  assert.equal(m.announcement.enabled, false);
  assert.deepEqual(m.announcement.messages, [{ text: 'Hi', icon: 'card_logos' }]);
});
