const fs = require('fs');
let code = fs.readFileSync('src/controllers/admin/orderController.ts', 'utf8');

const target = `  if (req.query.hasCustomer === 'true') {
    filter.$or = [
      { customerName: { $exists: true, $ne: '', $ne: null } },
      { customerEmail: { $exists: true, $ne: '', $ne: null } }
    ];
  } else if (req.query.hasCustomer === 'false') {
    filter.$and = [
      { $or: [{ customerName: { $exists: false } }, { customerName: '' }, { customerName: null }] },
      { $or: [{ customerEmail: { $exists: false } }, { customerEmail: '' }, { customerEmail: null }] }
    ];
  }`;

const replacement = `  if (req.query.hasCustomer === 'true') {
    filter.$or = [
      { customerName: { $nin: ['', null] } },
      { customerEmail: { $nin: ['', null] } },
      { 'customer.firstName': { $nin: ['', null] } }
    ];
  } else if (req.query.hasCustomer === 'false') {
    filter.$and = [
      { customerName: { $in: ['', null] } },
      { customerEmail: { $in: ['', null] } },
      { 'customer.firstName': { $in: ['', null] } }
    ];
  }`;

code = code.replace(target.replace(/\n/g, '\r\n'), replacement.replace(/\n/g, '\r\n'));
fs.writeFileSync('src/controllers/admin/orderController.ts', code);
console.log('Replaced successfully');
