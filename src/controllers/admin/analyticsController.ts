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
  const liveWindow = new Date(now.getTime() - 5 * 60 * 1000);

  // 1. Fire ALL top-level queries concurrently
  const [
    liveResult,
    currentSalesAgg,
    prevSalesAgg,
    currentSessionsList,
    prevSessionsList,
    orders,
    prevOrders,
    cartSessions5m,
    checkoutSessions5m,
    purchaseSessions5m,
    pendingOrdersCount5m,
    cartSessionsFull,
    checkoutSessionsFull,
    purchaseSessionsFull,
    pendingOrdersValueAgg,
    purchasedCount,
    rawEvents,
    countryResultInitial
  ] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: { timestamp: { $gte: liveWindow } } },
      { $group: { _id: '$sessionId' } },
      { $count: 'count' },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$grandTotal', '$totalAmount'] } } } },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: prevFrom, $lte: prevTo }, paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$grandTotal', '$totalAmount'] } } } },
    ]),
    AnalyticsEvent.distinct('sessionId', { timestamp: { $gte: from, $lte: to } }),
    AnalyticsEvent.distinct('sessionId', { timestamp: { $gte: prevFrom, $lte: prevTo } }),
    Order.countDocuments({ createdAt: { $gte: from, $lte: to }, paymentStatus: 'paid' }),
    Order.countDocuments({ createdAt: { $gte: prevFrom, $lte: prevTo }, paymentStatus: 'paid' }),
    AnalyticsEvent.distinct('sessionId', { eventType: 'add_to_cart', timestamp: { $gte: liveWindow } }),
    AnalyticsEvent.distinct('sessionId', { eventType: 'begin_checkout', timestamp: { $gte: liveWindow } }),
    AnalyticsEvent.distinct('sessionId', { eventType: 'purchase', timestamp: { $gte: liveWindow } }),
    Order.countDocuments({ createdAt: { $gte: liveWindow }, paymentStatus: { $ne: 'paid' } }),
    AnalyticsEvent.distinct('sessionId', { eventType: 'add_to_cart', timestamp: { $gte: from, $lte: to } }),
    AnalyticsEvent.distinct('sessionId', { eventType: 'begin_checkout', timestamp: { $gte: from, $lte: to } }),
    AnalyticsEvent.distinct('sessionId', { eventType: 'purchase', timestamp: { $gte: from, $lte: to } }),
    Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, paymentStatus: { $ne: 'paid' } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$grandTotal', '$totalAmount'] } } } }
    ]),
    Order.countDocuments({ createdAt: { $gte: liveWindow }, paymentStatus: 'paid' }),
    AnalyticsEvent.find({}).sort({ timestamp: -1 }).limit(15).lean(),
    AnalyticsEvent.aggregate([
      { $match: { timestamp: { $gte: from, $lte: to }, country: { $exists: true, $nin: [null, ''] } } },
      { $group: { _id: { country: '$country', session: '$sessionId' } } },
      { $group: { _id: '$_id.country', sessions: { $sum: 1 } } },
      { $sort: { sessions: -1 } as any },
      { $limit: 20 },
      { $project: { _id: 0, country: '$_id', sessions: 1 } },
    ])
  ]);

  // 2. Extract values
  const visitorsRightNow = liveResult[0]?.count ?? 0;
  const totalSales = currentSalesAgg[0]?.total ?? 0;
  const prevTotalSales = prevSalesAgg[0]?.total ?? 0;
  const totalSalesChangePct = prevTotalSales > 0 ? Math.round(((totalSales - prevTotalSales) / prevTotalSales) * 100) : totalSales > 0 ? 100 : 0;
  
  const sessions = currentSessionsList.length;
  const prevSessions = prevSessionsList.length;
  const sessionsChangePct = prevSessions > 0 ? Math.round(((sessions - prevSessions) / prevSessions) * 100) : sessions > 0 ? 100 : 0;

  const ordersChangePct = prevOrders > 0 ? Math.round(((orders - prevOrders) / prevOrders) * 100) : orders > 0 ? 100 : 0;

  const checkoutSet5m = new Set(checkoutSessions5m as string[]);
  const purchaseSet5m = new Set(purchaseSessions5m as string[]);
  const activeCartsCount = (cartSessions5m as string[]).filter(s => !checkoutSet5m.has(s) && !purchaseSet5m.has(s)).length;
  const checkingOutCount = Math.max((checkoutSessions5m as string[]).filter(s => !purchaseSet5m.has(s)).length, pendingOrdersCount5m);

  const funnelActiveCarts = new Set([...(cartSessionsFull as string[]), ...(checkoutSessionsFull as string[]), ...(purchaseSessionsFull as string[])]).size;
  const funnelCheckingOut = new Set([...(checkoutSessionsFull as string[]), ...(purchaseSessionsFull as string[])]).size;
  const funnelPurchased = orders; // Completed paid orders count

  const abandonedCartValue = pendingOrdersValueAgg[0]?.total ?? 0;
  const conversionRate = sessions > 0 ? Number(((orders / sessions) * 100).toFixed(1)) : 0;

  const funnel = {
    sessions,
    activeCarts: funnelActiveCarts,
    checkingOut: funnelCheckingOut,
    purchased: funnelPurchased,
    cartDropOffPct: (sessions > 0 && funnelActiveCarts < sessions) ? Math.round(((sessions - funnelActiveCarts) / sessions) * 100) : 0,
    checkoutDropOffPct: (funnelActiveCarts > 0) ? Math.round(((funnelActiveCarts - funnelCheckingOut) / funnelActiveCarts) * 100) : 0
  };

  // 3. Fire all 36 Sparkline queries concurrently
  const numBuckets = 12;
  const intervalMs = durationMs / numBuckets;
  const sparklinePromises = [];

  for (let i = 0; i < numBuckets; i++) {
    const bFrom = new Date(from.getTime() + i * intervalMs);
    const bTo = new Date(from.getTime() + (i + 1) * intervalMs);
    sparklinePromises.push(Promise.all([
      Order.aggregate([
        { $match: { createdAt: { $gte: bFrom, $lt: bTo }, paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$grandTotal', '$totalAmount'] } } } },
      ]),
      AnalyticsEvent.distinct('sessionId', { timestamp: { $gte: bFrom, $lt: bTo } }),
      Order.countDocuments({ createdAt: { $gte: bFrom, $lt: bTo }, paymentStatus: 'paid' })
    ]));
  }

  const sparklineResults = await Promise.all(sparklinePromises);
  const sparklines = sparklineResults.map(([bSalesAgg, bSessionsList, bOrdersCount]) => ({
    sales: (bSalesAgg as any[])[0]?.total ?? 0,
    sessions: (bSessionsList as any[]).length,
    orders: bOrdersCount as number,
  }));

  // 4. Country Fallback (if AnalyticsEvent didn't yield anything)
  let countryResult = countryResultInitial as any[];
  if (countryResult.length === 0) {
    const orderCountries = await Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, 'shippingAddressObj.country': { $exists: true, $nin: [null, ''] } } },
      { $group: { _id: '$shippingAddressObj.country', sessions: { $sum: 1 } } },
      { $project: { _id: 0, country: '$_id', sessions: 1 } }
    ]);
    if (orderCountries.length > 0) countryResult = orderCountries;
  }

  // 5. Clean up recent events output
  const recentEvents = (rawEvents as any[]).map((evt: any) => ({
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

export const getAttributionStats = catchAsync(async (req: Request, res: Response) => {
  const match = buildMatchFilter(req);
  
  // Only include paid orders for attribution revenue
  match.paymentStatus = { $in: ['paid', 'succeeded'] };
  
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: {
          source: "$attribution.firstTouch.source",
          channel: "$attribution.firstTouch.channel"
        },
        ordersCount: { $sum: 1 },
        revenue: { $sum: { $ifNull: ["$grandTotal", "$totalAmount"] } }
      }
    },
    {
      $project: {
        _id: 0,
        source: { $ifNull: ["$_id.source", "Direct / Unknown"] },
        channel: { $ifNull: ["$_id.channel", "direct"] },
        ordersCount: 1,
        revenue: 1
      }
    },
    { $sort: { revenue: -1 } as any }
  ];

  const data = await Order.aggregate(pipeline);
  res.json({ success: true, data });
});
