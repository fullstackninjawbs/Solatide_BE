import { Request, Response, NextFunction } from 'express';
import Customer from '../../models/Customer';
import Order from '../../models/order.model';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
import { escapeRegex } from '../../utils/collectionUtils';

// GET /api/admin/customers
export const getCustomers = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  // Basic searching by name or email
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const filter: any = {};
  if (search) {
    const safe = escapeRegex(search);
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { email: { $regex: safe, $options: 'i' } }
    ];
  }

  const customers = await Customer.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Customer.countDocuments(filter);

  res.status(200).json({
    success: true,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    data: {
      customers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

/**
 * One CSV cell: quoted, quotes doubled, and a leading = + - @ (or tab / CR) neutralised with an
 * apostrophe so a spreadsheet never runs a customer's name or address as a formula.
 */
const csvCell = (v: unknown): string => {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

// GET /api/admin/customer/export/csv?search= — the customer list (same search as the page) as CSV
export const exportCustomersCsv = catchAsync(async (req: Request, res: Response) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const filter: any = {};
  if (search) {
    const safe = escapeRegex(search);
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { email: { $regex: safe, $options: 'i' } }
    ];
  }
  const customers: any[] = await Customer.find(filter).sort({ createdAt: -1, _id: -1 }).lean();

  // First and last order date per customer email (deleted orders left out)
  const emails = customers.map((c) => c.email).filter(Boolean);
  const orderDates: any[] = emails.length
    ? await Order.aggregate([
      { $match: { isDeleted: { $ne: true }, customerEmail: { $in: emails } } },
      { $group: { _id: '$customerEmail', first: { $min: '$createdAt' }, last: { $max: '$createdAt' } } },
    ])
    : [];
  const datesByEmail = new Map(orderDates.map((d) => [String(d._id), d]));
  const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : '');

  const headers = [
    'Name', 'Email', 'Phone', 'Address Line 1', 'Address Line 2', 'Suburb / City', 'State', 'Postcode', 'Country',
    'Orders', 'Total Spent (AUD)', 'First Order', 'Last Order', 'Tags', 'Banned', 'Customer Since',
  ];
  const rows = customers.map((c) => {
    const a = c.defaultAddress || {};
    const dates = datesByEmail.get(String(c.email)) || {};
    return [
      c.name, c.email, c.phone || a.phone || '', a.street1, a.street2, a.city, a.state, a.zip, a.country || c.country,
      Number(c.orderCount) || 0, (Number(c.totalSpent) || 0).toFixed(2), day(dates.first), day(dates.last),
      (c.tags || []).join(', '), c.banned ? 'Yes' : 'No', day(c.createdAt),
    ].map(csvCell).join(',');
  });

  const user: any = (req as any).user;
  console.log(`[Admin Customers] CSV export of ${customers.length} customer(s)${search ? ` (search "${search}")` : ''} by ${user?.email || 'admin'}`);

  // BOM: Excel opens the file as UTF-8 (names with accents / non-Latin characters)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=customers_export.csv');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send('﻿' + [headers.map(csvCell).join(','), ...rows].join('\r\n'));
});

// GET /api/admin/customers/:id
export const getCustomerById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  // Fetch their full order history
  const orders = await Order.find({ 
    $and: [
      {
        $or: [
          { customerEmail: customer.email },
          { 'customer.email': customer.email }
        ]
      },
      { isDeleted: { $ne: true } }
    ]
  }).sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    data: {
      customer,
      orders
    }
  });
});

// PUT /api/admin/customers/:id
export const updateCustomer = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { name, email, phone, defaultAddress, country, tags, banned, comments } = req.body;
  
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { name, email, phone, defaultAddress, country, tags, banned, comments },
    { new: true, runValidators: true }
  );

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  res.status(200).json({
    success: true,
    data: {
      customer
    }
  });
});
