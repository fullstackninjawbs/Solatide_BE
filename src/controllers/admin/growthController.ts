import { Request, Response, NextFunction } from 'express';
import { NewsletterSubscriber } from '../../models/marketing.model';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/appError';

export const getPlaceholder = async (req: Request, res: Response) => {
  res.json({ message: 'Stub for growthController.ts' });
};

// @desc    Get all newsletter subscribers
// @route   GET /api/admin/growth/subscribers
// @access  Private/Admin
export const getSubscribers = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const subscribers = await NewsletterSubscriber.find()
    .sort('-subscribedAt')
    .skip(skip)
    .limit(limit);

  const total = await NewsletterSubscriber.countDocuments();

  res.status(200).json({
    success: true,
    data: subscribers,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// @desc    Delete a newsletter subscriber
// @route   DELETE /api/admin/growth/subscribers/:id
// @access  Private/Admin
export const deleteSubscriber = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const subscriber = await NewsletterSubscriber.findByIdAndDelete(req.params.id);

  if (!subscriber) {
    return next(new AppError('No subscriber found with that ID', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Subscriber deleted successfully'
  });
});
