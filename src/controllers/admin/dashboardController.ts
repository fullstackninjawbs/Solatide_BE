import { Request, Response, NextFunction } from 'express';
import Order from '../../models/order.model';
import Customer from '../../models/Customer';
import Product from '../../models/product.model';
import COA from '../../models/coa.model';
import Review from '../../models/review.model';
import catchAsync from '../../utils/catchAsync';
import { buildRevenueMatch, netRevenueExpr } from '../../domain/revenue';
import { lowStockThresholdFor } from '../../utils/lowStock';

export const getDashboardAnalytics = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const timeFilter = (req.query.timeFilter as string) || 'Today';

  const now = new Date();
  let startDate = new Date();
  let endDate = new Date();
  let prevStartDate = new Date();
  let prevEndDate = new Date();

  if (timeFilter === 'Today') {
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
    prevStartDate = new Date(startDate);
    prevStartDate.setDate(prevStartDate.getDate() - 1);
    prevEndDate = new Date(endDate);
    prevEndDate.setDate(prevEndDate.getDate() - 1);
  } else if (timeFilter === 'This Week') {
    const day = startDate.getDay();
    const diff = startDate.getDate() - day + (day === 0 ? -6 : 1);
    startDate.setDate(diff);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);

    prevStartDate = new Date(startDate);
    prevStartDate.setDate(prevStartDate.getDate() - 7);
    prevEndDate = new Date(endDate);
    prevEndDate.setDate(prevEndDate.getDate() - 7);
  } else if (timeFilter === 'This Month') {
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0, 23, 59, 59, 999);

    prevStartDate = new Date(startDate);
    prevStartDate.setMonth(prevStartDate.getMonth() - 1);
    prevEndDate = new Date(prevStartDate.getFullYear(), prevStartDate.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (timeFilter === 'Year to Date') {
    startDate.setMonth(0, 1);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date();

    prevStartDate = new Date(startDate);
    prevStartDate.setFullYear(prevStartDate.getFullYear() - 1);
    prevEndDate = new Date(now);
    prevEndDate.setFullYear(prevEndDate.getFullYear() - 1);
  } else {
    // Default fallback
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
    prevStartDate = new Date(startDate);
    prevStartDate.setDate(prevStartDate.getDate() - 1);
    prevEndDate = new Date(endDate);
    prevEndDate.setDate(prevEndDate.getDate() - 1);
  }

  // Helper to aggregate revenue
  const getRevenue = async (start: Date, end: Date) => {
    const result = await Order.aggregate([
      { $match: buildRevenueMatch({ createdAt: { $gte: start, $lte: end } }) },
      { $group: { _id: null, total: { $sum: netRevenueExpr } } }
    ]);
    return result[0]?.total || 0;
  };

  const currentRevenue = await getRevenue(startDate, endDate);
  const prevRevenue = await getRevenue(prevStartDate, prevEndDate);

  const currentOrders = await Order.countDocuments(buildRevenueMatch({ createdAt: { $gte: startDate, $lte: endDate } }));
  const prevOrders = await Order.countDocuments(buildRevenueMatch({ createdAt: { $gte: prevStartDate, $lte: prevEndDate } }));

  const currentAOV = currentOrders > 0 ? currentRevenue / currentOrders : 0;
  const prevAOV = prevOrders > 0 ? prevRevenue / prevOrders : 0;

  const currentCustomers = await Customer.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } });
  const prevCustomers = await Customer.countDocuments({ createdAt: { $gte: prevStartDate, $lte: prevEndDate } });

  const calculateChange = (current: number, prev: number) => {
    if (prev === 0) return current > 0 ? '+100%' : '0%';
    const percent = ((current - prev) / prev) * 100;
    return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
  };

  const stats = [
    { name: `Revenue (${timeFilter})`, value: currentRevenue, change: calculateChange(currentRevenue, prevRevenue), id: 'revenue' },
    { name: `Orders ${timeFilter}`, value: currentOrders.toString(), change: calculateChange(currentOrders, prevOrders), id: 'orders' },
    { name: 'Average Order Value', value: currentAOV, change: calculateChange(currentAOV, prevAOV), id: 'aov' },
    { name: 'New Customers', value: currentCustomers.toString(), change: calculateChange(currentCustomers, prevCustomers), id: 'customers' }
  ];

  // Low Stock
  // Product stockQuantity vs the same threshold as the low-stock alert email: LOW_STOCK_THRESHOLD
  // (.env, default 5) or the product's own threshold where it was customised. Archived excluded.
  const candidates = await Product.find({ publishStatus: { $ne: 'archived' } })
    .select('name sku stockQuantity lowStockThreshold').lean();
  const lowStockProducts = candidates
    .map((p: any) => ({ name: p.name, sku: p.sku || 'N/A', stock: Number(p.stockQuantity ?? 0), limit: lowStockThresholdFor(p) }))
    .filter((p) => p.stock <= p.limit)
    .sort((a, b) => a.stock - b.stock)
    .slice(0, 10);

  // Recent Orders
  const recentOrders = await Order.find(buildRevenueMatch())
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('customer', 'name email')
    .select('orderNumber createdAt grandTotal totalAmount refundedAmount currency status paymentStatus customer customerName customerEmail');

  // Recent Customers
  const recentCustomers = await Customer.find()
    .sort({ createdAt: -1 })
    .limit(5)
    .select('name email createdAt orderCount');

  res.json({
    success: true,
    data: {
      stats,
      lowStockProducts,
      recentOrders,
      recentCustomers
    }
  });
});
