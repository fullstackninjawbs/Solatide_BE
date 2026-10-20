import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STOREFRONT_STATIC_PAGES, isLiveItem, targetStatus } from '../src/services/redirectResolver';

// Built-in storefront pages are answered from the list alone (no database query).
test('redirects to built-in storefront pages are not "Target not found"', async () => {
  for (const p of ['/pages/faq', '/pages/terms-of-services', '/pages/refund-policy', '/pages/shipping-policy', '/pages/privacy-policy', '/pages/coa', '/collections/all']) {
    assert.equal(await targetStatus(p), 'live', p);
    assert.equal(await targetStatus(`${p}?utm_source=x`), 'live', `${p} with query`);
    assert.equal(await isLiveItem(p), true, p);
  }
});

test('built-in page list matches STATIC_ROUTES in Client/prerender.js', { skip: !fs.existsSync(path.join(__dirname, '../../Client/prerender.js')) }, () => {
  const src = fs.readFileSync(path.join(__dirname, '../../Client/prerender.js'), 'utf8');
  const block = src.match(/const STATIC_ROUTES = \[([\s\S]*?)\];/);
  assert.ok(block, 'STATIC_ROUTES found');
  const client = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((r) => r !== '/');
  assert.deepEqual([...STOREFRONT_STATIC_PAGES].sort(), client.sort());
});
