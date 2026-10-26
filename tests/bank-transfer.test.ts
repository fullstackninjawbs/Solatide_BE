import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  methodsForCountry, shippingFor, publicCheckoutConfig, instructionsFor, validateCheckoutInput,
  CheckoutInputError, type BankTransferSettings,
} from '../src/services/checkout/bankTransfer';

const S: BankTransferSettings = {
  enabled: true, accountName: 'Solatide Biosciences', bankName: 'Commonwealth Bank of Australia', bsb: '067 873',
  accountNumber: '2248 6439', payId: 'pay@solatidebiosciences.com', swiftBic: 'CTBAAU2S',
  shippingFeeAU: 15, shippingFeeInternational: 45, freeShippingThresholdAU: 300, internationalEnabled: true,
  unpaidCancelDays: 3, notifyAdminOnOrder: true,
};
const valid = {
  customer: { email: ' Jane.Doe@Example.com ', firstName: 'Jane', lastName: 'Doe', phone: '0412 345 678' },
  shippingAddress: { street1: '1 Test St', city: 'Sydney', state: 'nsw', zip: '2000', country: 'au' },
  paymentMethod: 'payid',
};

test('Australia → PayID + Bank Transfer; elsewhere → International only', () => {
  assert.deepEqual(methodsForCountry('AU', S), ['payid', 'bank_transfer']);
  assert.deepEqual(methodsForCountry('NZ', S), ['international_bank_transfer']);
  assert.deepEqual(methodsForCountry('US', { ...S, internationalEnabled: false }), []);
  assert.deepEqual(methodsForCountry('AU', { ...S, payId: '' }), ['bank_transfer'], 'PayID hidden when not configured');
  assert.deepEqual(methodsForCountry('GB', { ...S, swiftBic: '' }), [], 'international needs SWIFT');
});

test('checkout mode: off unless enabled AND a method is configured', () => {
  assert.equal(publicCheckoutConfig(S).mode, 'bank_transfer');
  assert.equal(publicCheckoutConfig({ ...S, enabled: false }).mode, 'tagada');
  assert.equal(publicCheckoutConfig({ ...S, payId: '', bsb: '', accountNumber: '' }).mode, 'tagada');
  assert.ok(!JSON.stringify(publicCheckoutConfig(S)).includes('2248'), 'public config never contains bank details');
});

test('shipping: AU flat with free threshold, international flat', () => {
  assert.deepEqual(shippingFor('AU', 120, S), { amount: 15, name: 'Standard shipping' });
  assert.deepEqual(shippingFor('AU', 300, S), { amount: 0, name: 'Free shipping' });
  assert.deepEqual(shippingFor('NZ', 999, S), { amount: 45, name: 'International shipping' });
  assert.deepEqual(shippingFor('AU', 10_000, { ...S, freeShippingThresholdAU: 0 }), { amount: 15, name: 'Standard shipping' });
});

test('instructions show only the chosen method, with the order amount and reference', () => {
  const o = { orderNumber: 'SLT1234567B', grandTotal: 249 };
  const p = instructionsFor('payid', S, o);
  assert.equal(p.label, 'Pay with PayID — Australia Only');
  assert.deepEqual(p.fields.map((f) => [f.label, f.value, f.copy]), [
    ['PayID', 'pay@solatidebiosciences.com', true], ['Account Name', 'Solatide Biosciences', false],
    ['Amount', '$249.00 AUD', true], ['Reference', 'SLT1234567B', true],
  ]);
  const b = instructionsFor('bank_transfer', S, o);
  assert.deepEqual(b.fields.filter((f) => f.copy).map((f) => f.label), ['BSB', 'Account Number', 'Amount', 'Reference']);
  assert.ok(!b.fields.some((f) => f.label === 'PayID'));
  const i = instructionsFor('international_bank_transfer', S, o);
  assert.deepEqual(i.fields.filter((f) => f.copy).map((f) => f.label), ['Account Number', 'SWIFT / BIC', 'Amount', 'Reference']);
  assert.ok(i.fields.some((f) => f.label === 'Currency' && f.value === 'AUD'));
  assert.match(i.notes[0], /Australian Dollars \(AUD\)/);
});

test('input validation: normalises, and rejects bad email/phone/AU state/postcode', () => {
  const r = validateCheckoutInput(valid);
  assert.equal(r.customer.email, 'jane.doe@example.com');
  assert.equal(r.address.country, 'AU');
  assert.equal(r.address.state, 'NSW');
  const bad = (patch: any) => assert.throws(() => validateCheckoutInput({ ...valid, ...patch }), CheckoutInputError);
  bad({ customer: { ...valid.customer, email: 'nope' } });
  bad({ customer: { ...valid.customer, phone: '12' } });
  bad({ shippingAddress: { ...valid.shippingAddress, state: 'XYZ' } });
  bad({ shippingAddress: { ...valid.shippingAddress, zip: '200' } });
  bad({ paymentMethod: 'card' });
  // international: any state, postal code required
  const nz = validateCheckoutInput({ ...valid, shippingAddress: { street1: '1 Queen St', city: 'Auckland', state: '', zip: '1010', country: 'NZ' }, paymentMethod: 'international_bank_transfer' });
  assert.equal(nz.address.country, 'NZ');
});
