import { Request, Response, NextFunction } from 'express';
import { FaqSection } from '../../models/cms.model';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';

// GET /api/admin/content/faqs
export const getFaqSections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const faqSections = await FaqSection.find().sort({ sortOrder: 1 });
  
  res.status(200).json({
    success: true,
    data: {
      faqSections
    }
  });
});

// POST /api/admin/content/faqs
export const createFaqSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { name, sortOrder, questions } = req.body;

  const newSection = await FaqSection.create({
    name,
    sortOrder,
    questions: questions || []
  });

  res.status(201).json({
    success: true,
    data: {
      faqSection: newSection
    }
  });
});

// PUT /api/admin/content/faqs/:id
export const updateFaqSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { name, sortOrder, questions } = req.body;

  const updatedSection = await FaqSection.findByIdAndUpdate(
    req.params.id,
    { name, sortOrder, questions },
    { new: true, runValidators: true }
  );

  if (!updatedSection) {
    return next(new AppError('FAQ Section not found', 404));
  }

  res.status(200).json({
    success: true,
    data: {
      faqSection: updatedSection
    }
  });
});

// DELETE /api/admin/content/faqs/:id
export const deleteFaqSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const section = await FaqSection.findByIdAndDelete(req.params.id);

  if (!section) {
    return next(new AppError('FAQ Section not found', 404));
  }

  res.status(204).json({
    success: true,
    data: null
  });
});
