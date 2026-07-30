import { Request, Response } from 'express';
import Order from '../../models/order.model';
import AnalyticsEvent from '../../models/analyticsEvent.model';
import catchAsync from '../../utils/catchAsync';

const buildMatchFilter = (req: Request) => {
  const { from, to, paymentMethod } = req.query;
  const match: any = {};
  
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from as string);
    if (to) match.createdAt.$lte = new Date(to as string);
  }
  
  if (paymentMethod && paymentMethod !== 'All') {
    match.paymentMethod = paymentMethod;
  }
  
  return match;
};

export const getSummary = catchAsync(async (req: Request, res: Response) => {
  const match = buildMatchFilter(req);
  
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $ifNull: ["$grandTotal", "$totalAmount"] } },
        paidOrders: {
          $sum: { $cond: [{ $eq: ["$paymentStatus", "paid"] }, 1, 0] }
        },
        refundedOrders: {
          $sum: { $cond: [{ $eq: ["$paymentStatus", "refunded"] }, 1, 0] }
        }
      }
    }
  ];

  const result = await Order.aggregate(pipeline);
  const data = result[0] || { totalOrders: 0, totalRevenue: 0, paidOrders: 0, refundedOrders: 0 };
  data.averageOrderValue = data.totalOrders > 0 ? data.totalRevenue / data.totalOrders : 0;

  res.json({ success: true, data });
});

export const getOrdersByDay = catchAsync(async (req: Request, res: Response) => {
  const match = buildMatchFilter(req);
  
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        ordersCount: { $sum: 1 },
        revenue: { $sum: { $ifNull: ["$grandTotal", "$totalAmount"] } }
      }
    },
    { $sort: { "_id": 1 } as any },
    {
      $project: {
        _id: 0,
        date: "$_id",
        ordersCount: 1,
        revenue: 1
      }
    }
  ];

  const data = await Order.aggregate(pipeline);
  res.json({ success: true, data });
});

export const getOrdersByStatus = catchAsync(async (req: Request, res: Response) => {
  const match = buildMatchFilter(req);
  
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$paymentStatus",
        count: { $sum: 1 }
      }
    },
    {
      $project: {
        _id: 0,
        status: "$_id",
        count: 1
      }
    }
  ];

  const data = await Order.aggregate(pipeline);
  res.json({ success: true, data });
});

export const getRevenueByProduct = catchAsync(async (req: Request, res: Response) => {
  const match = buildMatchFilter(req);
  
  const pipeline = [
    { $match: match },
    { $unwind: "$lineItems" },
    {
      $group: {
        _id: "$lineItems.title",
        totalRevenue: { $sum: "$lineItems.subtotal" },
        totalQuantity: { $sum: "$lineItems.quantity" }
      }
    },
    { $sort: { totalRevenue: -1 } as any },
    { $limit: 10 },
    {
      $project: {
        _id: 0,
        productTitle: "$_id",
        productId: "$_id", // Since lineItems don't strictly keep productId, we use title as ID
        totalRevenue: 1,
        totalQuantity: 1
      }
    }
  ];

  const data = await Order.aggregate(pipeline);
  res.json({ success: true, data });
});

export const getTopCustomers = catchAsync(async (req: Request, res: Response) => {
  const match = buildMatchFilter(req);
  
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ["$customer.email", "$customerEmail"] },
        firstName: { $first: "$customer.firstName" },
        lastName: { $first: "$customer.lastName" },
        customerName: { $first: "$customerName" },
        totalRevenue: { $sum: "$grandTotal" },
        ordersCount: { $sum: 1 }
      }
    },
    { $match: { _id: { $ne: null } } },
    { $sort: { totalRevenue: -1 } as any },
    { $limit: 10 },
    {
      $project: {
        _id: 0,
        email: "$_id",
        name: {
          $cond: {
            if: { $or: ["$firstName", "$lastName"] },
            then: { $concat: [{ $ifNull: ["$firstName", ""] }, " ", { $ifNull: ["$lastName", ""] }] },
            else: { $ifNull: ["$customerName", "Unknown"] }
          }
        },
        totalRevenue: 1,
        ordersCount: 1
      }
    }
  ];

  const data = await Order.aggregate(pipeline);
  res.json({ success: true, data });
});

// ─── Live / Session Overview ──────────────────────────────────────────────────

/**
 * GET /api/admin/analytics/overview?from=<ISO>&to=<ISO>
 * Returns live visitors, sessions, orders, abandoned carts, sessions by country.
 */
export const getOverview = catchAsync(async (req: Request, res: Response) => {
  const now = new Date();

  // Date range for period metrics (default: last 7 days)
  const to = req.query.to ? new Date(req.query.to as string) : now;
  const from = req.query.from
    ? new Date(req.query.from as string)
    : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 1. Live visitors — distinct sessions with any event in last 5 minutes
  const liveWindow = new Date(now.getTime() - 5 * 60 * 1000);
  const liveResult = await AnalyticsEvent.aggregate([
    { $match: { timestamp: { $gte: liveWindow } } },
    { $group: { _id: '$sessionId' } },
    { $count: 'count' },
  ]);
  const liveVisitors = liveResult[0]?.count ?? 0;

  // 2. Sessions in period
  const sessionsResult = await AnalyticsEvent.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to } } },
    { $group: { _id: '$sessionId' } },
    { $count: 'count' },
  ]);
  const sessions = sessionsResult[0]?.count ?? 0;

  // 3. Orders in period (from existing Order model)
  const orders = await Order.countDocuments({ createdAt: { $gte: from, $lte: to } });

  // 4. Abandoned carts
  // Sessions that fired begin_checkout but never fired purchase in the same period
  const checkoutSessions = await AnalyticsEvent.distinct('sessionId', {
    eventType: 'begin_checkout',
    timestamp: { $gte: from, $lte: to },
  });

  let abandonedCarts = 0;
  if (checkoutSessions.length > 0) {
    const purchaseSessions = await AnalyticsEvent.distinct('sessionId', {
      eventType: 'purchase',
      sessionId: { $in: checkoutSessions },
      timestamp: { $gte: from, $lte: new Date(to.getTime() + 24 * 60 * 60 * 1000) },
    });
    abandonedCarts = checkoutSessions.length - purchaseSessions.length;
  }

  // 5. Sessions by country
  const countryResult = await AnalyticsEvent.aggregate([
    {
      $match: {
        timestamp: { $gte: from, $lte: to },
        country: { $exists: true, $nin: [null, ''] },
      },
    },
    { $group: { _id: { country: '$country', session: '$sessionId' } } },
    { $group: { _id: '$_id.country', sessions: { $sum: 1 } } },
    { $sort: { sessions: -1 } as any },
    { $limit: 20 },
    { $project: { _id: 0, country: '$_id', sessions: 1 } },
  ]);

  res.json({
    success: true,
    data: {
      liveVisitors,
      sessions,
      orders,
      abandonedCarts,
      sessionsByCountry: countryResult,
    },
  });
});
