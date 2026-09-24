const fs = require('fs');
let code = fs.readFileSync('src/controllers/admin/orderController.ts', 'utf8');

const target = "  // Build filter\r\n  const filter: Record<string, any> = {};\r\n  if (status) filter.status = status;";
const replacement = `  // Build filter\r
  const filter: Record<string, any> = {};\r
\r
  if (req.query.hasCustomer === 'true') {\r
    filter.$or = [\r
      { customerName: { $exists: true, $ne: '', $ne: null } },\r
      { customerEmail: { $exists: true, $ne: '', $ne: null } }\r
    ];\r
  } else if (req.query.hasCustomer === 'false') {\r
    filter.$and = [\r
      { $or: [{ customerName: { $exists: false } }, { customerName: '' }, { customerName: null }] },\r
      { $or: [{ customerEmail: { $exists: false } }, { customerEmail: '' }, { customerEmail: null }] }\r
    ];\r
  }\r
\r
  if (status) filter.status = status;`;

code = code.replace(target, replacement);

const targetSearch = `    filter.$or = [
      { orderNumber: { $regex: escapedQ, $options: 'i' } },
      { 'customer.email': { $regex: escapedQ, $options: 'i' } },
      { customerEmail: { $regex: escapedQ, $options: 'i' } },
      { customerName: { $regex: escapedQ, $options: 'i' } },
    ];`;

const replaceSearch = `    const searchFilter = {
      $or: [
        { orderNumber: { $regex: escapedQ, $options: 'i' } },
        { 'customer.email': { $regex: escapedQ, $options: 'i' } },
        { customerEmail: { $regex: escapedQ, $options: 'i' } },
        { customerName: { $regex: escapedQ, $options: 'i' } },
      ]
    };

    if (filter.$and) {
       filter.$and.push(searchFilter);
    } else if (filter.$or) {
       const existingOr = filter.$or;
       delete filter.$or;
       filter.$and = [ { $or: existingOr }, searchFilter ];
    } else {
       filter.$or = searchFilter.$or;
    }`;

code = code.replace(targetSearch.replace(/\n/g, '\r\n'), replaceSearch.replace(/\n/g, '\r\n'));
fs.writeFileSync('src/controllers/admin/orderController.ts', code);
console.log('Replaced successfully');
