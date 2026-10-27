import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCheckoutMode, checkoutModeOptions, isCheckoutMode } from '../src/services/checkout/checkoutMode';
import type { BankTransferSettings } from '../src/services/checkout/bankTransfer';

const BANK: BankTransferSettings = {
  enabled: false, accountName: 'Solatide Biosciences', bankName: 'Commonwealth Bank of Australia', bsb: '067 873',
  accountNumber: '2248 6439', payId: 'pay@solatidebiosciences.com', swiftBic: 'CTBAAU2S',
  shippingFeeAU: 14.95, shippingFeeInternational: 49.95, freeShippingThresholdAU: 0, internationalEnabled: true,
  unpaidCancelDays: 3, notifyAdminOnOrder: true,
};
const NO_BANK: BankTransferSettings = { ...BANK, accountName: '', bsb: '', accountNumber: '', payId: '', swiftBic: '' };
const env = (v?: string) => (v === undefined ? {} : { ORDER_REQUEST_CHECKOUT: v }) as NodeJS.ProcessEnv;

test('checkout mode: the mode saved in Admin wins when it is ready', () => {
  assert.equal(effectiveCheckoutMode('order_request', BANK, env()), 'order_request');
  assert.equal(effectiveCheckoutMode('bank_transfer', BANK, env('true')), 'bank_transfer', 'saved mode beats the env flag');
  assert.equal(effectiveCheckoutMode('order_request', { ...BANK, enabled: true }, env()), 'order_request', 'saved mode beats the old bank switch');
});

test('checkout mode: nothing saved → legacy switches (deploy changes nothing)', () => {
  assert.equal(effectiveCheckoutMode(null, BANK, env('true')), 'order_request');
  assert.equal(effectiveCheckoutMode(null, { ...BANK, enabled: true }, env()), 'bank_transfer');
  assert.equal(effectiveCheckoutMode(null, BANK, env()), 'tagada');
  assert.equal(effectiveCheckoutMode(undefined, { ...NO_BANK, enabled: true }, env()), 'tagada', 'bank switch without details is not a checkout');
});

test('checkout mode: a saved mode that is not ready falls back instead of breaking checkout', () => {
  assert.equal(effectiveCheckoutMode('bank_transfer', NO_BANK, env('true')), 'order_request');
  assert.equal(effectiveCheckoutMode('external_processor', BANK, env('true')), 'order_request');
  assert.equal(effectiveCheckoutMode('pay_by_bank', BANK, env()), 'tagada');
  assert.equal(effectiveCheckoutMode('nonsense', BANK, env('true')), 'order_request');
});

test('checkout mode options: four modes; bank needs details; processor + Pay by Bank not connected', () => {
  const o = checkoutModeOptions(BANK);
  assert.deepEqual(o.map((x) => x.id), ['order_request', 'bank_transfer', 'external_processor', 'pay_by_bank']);
  assert.deepEqual(o.map((x) => x.status), ['ready', 'ready', 'not_connected', 'not_connected']);
  assert.equal(checkoutModeOptions(NO_BANK)[1].status, 'needs_setup');
  assert.ok(checkoutModeOptions(NO_BANK)[1].hint);
  assert.ok(isCheckoutMode('pay_by_bank') && !isCheckoutMode('tagada') && !isCheckoutMode(''));
});
