import { Request, Response, NextFunction } from 'express';
import { FaqSection } from '../../models/cms.model';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
import { sanitizeRichHtml } from '../../utils/sanitizeHtml';


/** Normalise FAQ questions; answers are rendered as HTML on the storefront. */
export const sanitizeQuestions = (questions: unknown) => {
  if (!Array.isArray(questions)) return [];
  return questions.map((q: any, idx: number) => ({
    ...(q && q._id ? { _id: q._id } : {}),
    question: typeof q?.question === 'string' ? q.question.trim().slice(0, 1000) : '',
    answer: sanitizeRichHtml(q?.answer),
    // Keep the admin's visibility toggle and order (dropping them reset every question to visible on save)
    isVisible: q?.isVisible !== false,
    sortOrder: Number.isFinite(Number(q?.sortOrder)) ? Number(q.sortOrder) : idx,
  }));
};

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
    questions: sanitizeQuestions(questions)
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
    { name, sortOrder, ...(questions !== undefined ? { questions: sanitizeQuestions(questions) } : {}) },
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
