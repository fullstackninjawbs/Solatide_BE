import { Request, Response, NextFunction } from 'express';
import { cacheGet, cacheSet, TTL } from '../utils/cache';
import { FaqSection } from '../models/cms.model';
import catchAsync from '../utils/catchAsync';

// GET /api/content/faqs
export const getPublicFaqSections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const CACHE_KEY = 'public:faqs';
  const cached = await cacheGet(CACHE_KEY);
  if (cached) return res.status(200).json(cached);

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

  const payload = {
    success: true,
    data: {
      faqSections: visibleSections
    }
  };
  await cacheSet(CACHE_KEY, payload, TTL.PUBLIC_CONTENT);
  res.status(200).json(payload);
});
