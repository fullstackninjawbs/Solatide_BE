import { Request, Response, NextFunction } from 'express';
import { FaqSection } from '../models/cms.model';
import catchAsync from '../utils/catchAsync';

// GET /api/content/faqs
export const getPublicFaqSections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  // Fetch all sections
  const sections = await FaqSection.find().sort({ sortOrder: 1 });
  
  // Filter questions to only include visible ones, and sort them
  const visibleSections = sections.map(section => {
    // Convert to plain object if needed, but array map works on mongoose docs too
    const s = section.toObject();
    s.questions = s.questions
      .filter((q: any) => q.isVisible !== false)
      .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return s;
  });

  res.status(200).json({
    success: true,
    data: {
      faqSections: visibleSections
    }
  });
});
