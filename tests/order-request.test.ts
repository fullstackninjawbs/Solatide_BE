import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderRequestInput, OrderRequestInputError, newRequestNumber } from '../src/services/checkout/orderRequest';

const valid = {
  customer: { email: ' Jane@Example.com ', firstName: 'Jane', lastName: 'Doe', phone: '0412 345 678' },
  shippingAddress: { street1: '1 Test St', city: 'Sydney', state: 'nsw', zip: '2000', country: 'au' },
  notes: 'Please call before delivery',
};

test('order request: normalises valid input', () => {
  const r = validateOrderRequestInput(valid);
  assert.equal(r.customer.email, 'jane@example.com');
  assert.equal(r.address.country, 'AU');
  assert.equal(r.address.state, 'NSW');
  assert.equal(r.notes, 'Please call before delivery');
});

test('order request: rejects bad email / phone / AU state / postcode, needs international postal code', () => {
  const bad = (patch: any) => assert.throws(() => validateOrderRequestInput({ ...valid, ...patch }), OrderRequestInputError);
  bad({ customer: { ...valid.customer, email: 'x' } });
  bad({ customer: { ...valid.customer, phone: '1' } });
  bad({ shippingAddress: { ...valid.shippingAddress, state: 'ZZ' } });
  bad({ shippingAddress: { ...valid.shippingAddress, zip: '20' } });
  bad({ shippingAddress: { street1: '1 Queen St', city: 'Auckland', zip: '', country: 'NZ' } });
  assert.equal(validateOrderRequestInput({ ...valid, shippingAddress: { street1: '1 Queen St', city: 'Auckland', zip: '1010', country: 'NZ' } }).address.country, 'NZ');
});

test('order request: readable unique-ish reference', () => {
  const n = newRequestNumber();
  assert.match(n, /^REQ-[2-9A-HJ-NP-Z]{6}$/);
  assert.notEqual(newRequestNumber(), n);
});
