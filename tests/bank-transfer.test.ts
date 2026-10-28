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

test('public bank config never contains bank details', () => {
  assert.deepEqual(publicCheckoutConfig(S).methods, { AU: ['payid', 'bank_transfer'], international: ['international_bank_transfer'] });
  assert.ok(!JSON.stringify(publicCheckoutConfig(S)).includes('2248'), 'public config never contains bank details');
});

test('shipping: AU flat with free threshold, international flat', () => {
  assert.deepEqual(shippingFor('AU', 120, S), { amount: 15, name: 'Express shipping' });
  assert.deepEqual(shippingFor('AU', 300, S), { amount: 0, name: 'Free shipping' });
  assert.deepEqual(shippingFor('NZ', 999, S), { amount: 45, name: 'International express shipping' });
  assert.deepEqual(shippingFor('AU', 10_000, { ...S, freeShippingThresholdAU: 0 }), { amount: 15, name: 'Express shipping' });
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
  assert.deepEqual(i.fields.filter((f) => f.copy).map((f) => f.label), ['SWIFT / BIC', 'Account Number', 'Amount', 'Payment Reference']);
  assert.ok(i.fields.some((f) => f.label === 'Currency' && f.value === 'AUD'));
  assert.ok(!i.fields.some((f) => f.key === 'iban' || f.key === 'beneficiaryAddress'), 'IBAN / address hidden when not set');
  assert.match(i.notes[0], /Australian Dollars \(AUD\)/);
});

test('international: IBAN + beneficiary address, in the order the client specified; never on AU methods', () => {
  const full = { ...S, iban: '06787322486439', beneficiaryAddress: 'Suite 329/98-100 Elizabeth Street, Melbourne VIC 3000, Australia' };
  const o = { orderNumber: 'SLT1234567B', grandTotal: 99 };
  assert.deepEqual(instructionsFor('international_bank_transfer', full, o).fields.map((f) => [f.label, f.value]), [
    ['Account Name', 'Solatide Biosciences'], ['Bank', 'Commonwealth Bank of Australia'], ['SWIFT / BIC', 'CTBAAU2S'],
    ['BSB', '067 873'], ['Account Number', '2248 6439'], ['IBAN (if required)', '06787322486439'], ['Currency', 'AUD'],
    ['Beneficiary Address', 'Suite 329/98-100 Elizabeth Street, Melbourne VIC 3000, Australia'],
    ['Amount', '$99.00 AUD'], ['Payment Reference', 'SLT1234567B'],
  ]);
  for (const m of ['payid', 'bank_transfer'] as const) {
    assert.ok(!instructionsFor(m, full, o).fields.some((f) => f.key === 'iban' || f.key === 'beneficiaryAddress'), m);
  }
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

test('payment due notice: days + date (shown on the payment page and in the email)', async () => {
  const { paymentDueNotice } = await import('../src/services/checkout/bankTransfer');
  const n = paymentDueNotice({ createdAt: '2026-10-27T02:00:00Z', paymentDueAt: '2026-10-30T02:00:00Z' });
  assert.equal(n, 'Please complete your payment within 3 days (by Fri 30 Oct 2026). Unpaid orders are cancelled automatically.');
  assert.equal(paymentDueNotice({ paymentDueAt: null }), null);
});
