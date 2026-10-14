import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairEditorLinks } from '../src/utils/repairEditorLinks';
import { sanitizeRichHtml } from '../src/utils/sanitizeHtml';

// Real artifacts saved from the Jodit editor (CMS pages, 2026-10-14)
test('repairs a nested empty link: inner (new) href wins, text stays one link', () => {
  assert.equal(
    repairEditorLinks('<a href="/pages/faqs">❓ <a href="/pages/faq"></a>FAQ</a>'),
    '<a href="/pages/faq">❓ FAQ</a>',
  );
  assert.equal(
    repairEditorLinks('<li><a href="/collections/metabolic-research">GLP-1 &amp; m<a href="/collections/glp-1-metabolic-peptides"></a>etabolic research peptides</a></li>'),
    '<li><a href="/collections/glp-1-metabolic-peptides">GLP-1 &amp; metabolic research peptides</a></li>',
  );
});

test('keeps the outer link attributes (class, target) unless the inner link sets them', () => {
  assert.equal(
    repairEditorLinks('<a class="pg-btn" target="_blank" href="/old">Go <a href="/new"></a>now</a>'),
    '<a class="pg-btn" target="_blank" href="/new">Go now</a>',
  );
  assert.equal(
    repairEditorLinks('<a class="a" href="/old">x<a class="b" href="/new"> </a></a>'),
    '<a class="b" href="/new">x</a>',
  );
});

test('leaves normal, sibling and non-empty links untouched', () => {
  const html = '<div class="pg-utility"><a href="/pages/coa">📄 COA</a><a href="/pages/faq">❓ FAQ</a></div><p>No links</p>';
  assert.equal(repairEditorLinks(html), html);
  const nestedNonEmpty = '<a href="/a">x<a href="/b">y</a>z</a>';
  assert.equal(repairEditorLinks(nestedNonEmpty), nestedNonEmpty);
});

test('drops leftover empty links and handles several artifacts in one document', () => {
  assert.equal(repairEditorLinks('<p>a<a href="/x"></a>b<a href="/y">&nbsp;</a></p>'), '<p>ab</p>');
  const doc = '<a href="/1">A<a href="/2"></a>B</a> | <a href="/3">C<a href="/4"></a>D</a>';
  assert.equal(repairEditorLinks(doc), '<a href="/2">AB</a> | <a href="/4">CD</a>');
});

test('is a no-op for non-link and empty input', () => {
  assert.equal(repairEditorLinks(''), '');
  assert.equal(repairEditorLinks('<p>plain</p>'), '<p>plain</p>');
  assert.equal(repairEditorLinks(undefined), '');
});

test('sanitizeRichHtml stores the repaired link (what admin saves)', () => {
  const out = sanitizeRichHtml('<div class="pg-utility"><a href="/pages/faqs">❓ <a href="/pages/faq"></a>FAQ</a></div>');
  assert.equal(out, '<div class="pg-utility"><a href="/pages/faq">❓ FAQ</a></div>');
});
