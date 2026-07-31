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

  // Date range for period metrics (default: last 24 hours for live view style)
  const to = req.query.to ? new Date(req.query.to as string) : now;
  const from = req.query.from
    ? new Date(req.query.from as string)
    : new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const durationMs = Math.max(to.getTime() - from.getTime(), 60000);
  const prevFrom = new Date(from.getTime() - durationMs);
  const prevTo = new Date(from.getTime());

  // 1. Visitors right now — distinct sessions in last 5 minutes
  const liveWindow = new Date(now.getTime() - 5 * 60 * 1000);
  const liveResult = await AnalyticsEvent.aggregate([
    { $match: { timestamp: { $gte: liveWindow } } },
    { $group: { _id: '$sessionId' } },
    { $count: 'count' },
  ]);
  const visitorsRightNow = liveResult[0]?.count ?? 0;

  // 2. Current period sales & previous period sales (ONLY paid orders count as completed sales)
  const currentSalesAgg = await Order.aggregate([
    { $match: { createdAt: { $gte: from, $lte: to }, paymentStatus: 'paid' } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$grandTotal', '$totalAmount'] } } } },
  ]);
  const totalSales = currentSalesAgg[0]?.total ?? 0;

  const prevSalesAgg = await Order.aggregate([
    { $match: { createdAt: { $gte: prevFrom, $lte: prevTo }, paymentStatus: 'paid' } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$grandTotal', '$totalAmount'] } } } },
  ]);
  const prevTotalSales = prevSalesAgg[0]?.total ?? 0;
  const totalSalesChangePct = prevTotalSales > 0 
    ? Math.round(((totalSales - prevTotalSales) / prevTotalSales) * 100)
    : totalSales > 0 ? 100 : 0;

  // 3. Current period sessions & previous period sessions
  const currentSessionsList = await AnalyticsEvent.distinct('sessionId', { timestamp: { $gte: from, $lte: to } });
  const sessions = currentSessionsList.length;

  const prevSessionsList = await AnalyticsEvent.distinct('sessionId', { timestamp: { $gte: prevFrom, $lte: prevTo } });
  const prevSessions = prevSessionsList.length;
  const sessionsChangePct = prevSessions > 0
    ? Math.round(((sessions - prevSessions) / prevSessions) * 100)
    : sessions > 0 ? 100 : 0;

  // 4. Current period orders & previous period orders (ONLY paid orders)
  const orders = await Order.countDocuments({ createdAt: { $gte: from, $lte: to }, paymentStatus: 'paid' });
  const prevOrders = await Order.countDocuments({ createdAt: { $gte: prevFrom, $lte: prevTo }, paymentStatus: 'paid' });
  const ordersChangePct = prevOrders > 0
    ? Math.round(((orders - prevOrders) / prevOrders) * 100)
    : orders > 0 ? 100 : 0;

  // 5. Customer Behavior
  // Active carts: sessions with add_to_cart in period that haven't checked out or purchased
  const cartSessions = await AnalyticsEvent.distinct('sessionId', {
    eventType: 'add_to_cart',
    timestamp: { $gte: from, $lte: to },
  });
  const checkoutSessions = await AnalyticsEvent.distinct('sessionId', {
    eventType: 'begin_checkout',
    timestamp: { $gte: from, $lte: to },
  });
  const purchaseSessions = await AnalyticsEvent.distinct('sessionId', {
    eventType: 'purchase',
    timestamp: { $gte: from, $lte: to },
  });

  // Pending/Unpaid orders count as checkout started, not purchased
  const pendingOrdersCount = await Order.countDocuments({
    createdAt: { $gte: from, $lte: to },
    paymentStatus: { $ne: 'paid' },
  });

  const pendingOrdersValueAgg = await Order.aggregate([
    { $match: { createdAt: { $gte: from, $lte: to }, paymentStatus: { $ne: 'paid' } } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$grandTotal', '$totalAmount'] } } } }
  ]);
  const abandonedCartValue = pendingOrdersValueAgg[0]?.total ?? 0;

  const checkoutSet = new Set(checkoutSessions);
  const purchaseSet = new Set(purchaseSessions);

  const activeCartsCount = cartSessions.filter(s => !checkoutSet.has(s) && !purchaseSet.has(s)).length;
  const checkingOutCount = Math.max(
    checkoutSessions.filter(s => !purchaseSet.has(s)).length,
    pendingOrdersCount
  );
  const purchasedCount = orders;

  // Conversion rate & Funnel
  const conversionRate = sessions > 0 ? Number(((orders / sessions) * 100).toFixed(1)) : 0;
  const funnel = {
    sessions,
    activeCarts: activeCartsCount + checkingOutCount + purchasedCount,
    checkingOut: checkingOutCount + purchasedCount,
    purchased: purchasedCount,
    cartDropOffPct: (sessions > 0 && (activeCartsCount + checkingOutCount + purchasedCount) < sessions)
      ? Math.round(((sessions - (activeCartsCount + checkingOutCount + purchasedCount)) / sessions) * 100)
      : 0,
    checkoutDropOffPct: ((activeCartsCount + checkingOutCount + purchasedCount) > 0)
      ? Math.round(((activeCartsCount) / (activeCartsCount + checkingOutCount + purchasedCount)) * 100)
      : 0
  };

  // 6. Sparkline trends (12 intervals) — strictly paid orders
  const numBuckets = 12;
  const intervalMs = durationMs / numBuckets;
  const sparklines = [];

  for (let i = 0; i < numBuckets; i++) {
    const bFrom = new Date(from.getTime() + i * intervalMs);
    const bTo = new Date(from.getTime() + (i + 1) * intervalMs);

    const bSalesAgg = await Order.aggregate([
      { $match: { createdAt: { $gte: bFrom, $lt: bTo }, paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$grandTotal', '$totalAmount'] } } } },
    ]);
    const bSessionsList = await AnalyticsEvent.distinct('sessionId', { timestamp: { $gte: bFrom, $lt: bTo } });
    const bOrdersCount = await Order.countDocuments({ createdAt: { $gte: bFrom, $lt: bTo }, paymentStatus: 'paid' });

    sparklines.push({
      sales: bSalesAgg[0]?.total ?? 0,
      sessions: bSessionsList.length,
      orders: bOrdersCount,
    });
  }

  // 7. Sessions by country (merge AnalyticsEvent country data and Order shipping country data)
  let countryResult = await AnalyticsEvent.aggregate([
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

  if (countryResult.length === 0) {
    const orderCountries = await Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, 'shippingAddressObj.country': { $exists: true, $nin: [null, ''] } } },
      { $group: { _id: '$shippingAddressObj.country', sessions: { $sum: 1 } } },
      { $project: { _id: 0, country: '$_id', sessions: 1 } }
    ]);
    if (orderCountries.length > 0) {
      countryResult = orderCountries;
    }
  }

  // 8. Recent Live Activity Events (last 15 events with clean fallback fields)
  const rawEvents = await AnalyticsEvent.find({})
    .sort({ timestamp: -1 })
    .limit(15)
    .lean();

  const recentEvents = rawEvents.map((evt: any) => ({
    ...evt,
    country: evt.country && evt.country !== 'undefined' ? evt.country : 'India',
    path: evt.path || evt.page || '/',
    productName: evt.productName || (evt.page && evt.page.includes('/product/') ? evt.page.split('/product/')[1]?.replace(/-/g, ' ') : undefined)
  }));

  res.json({
    success: true,
    data: {
      visitorsRightNow,
      liveVisitors: visitorsRightNow, // backward compatibility
      totalSales,
      totalSalesChangePct,
      sessions,
      sessionsChangePct,
      orders,
      ordersChangePct,
      abandonedCarts: checkingOutCount,
      abandonedCartValue,
      conversionRate,
      funnel,
      customerBehavior: {
        activeCarts: activeCartsCount,
        checkingOut: checkingOutCount,
        purchased: purchasedCount,
      },
      sparklines,
      sessionsByCountry: countryResult,
      recentEvents,
    },
  });
});

