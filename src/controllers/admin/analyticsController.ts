import { Request, Response } from 'express';
import Order from '../../models/order.model';
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
