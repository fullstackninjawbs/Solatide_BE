import { Request, Response, NextFunction } from 'express';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
import config from '../../config';
import { uploadImageBuffer } from '../../utils/cloudinary';
import { getHomepageContent, validateHomepageInput, saveHomepageContent, ContentInputError, HOMEPAGE_DEFAULTS, LIMITS } from '../../services/content/siteContent';

// GET /api/admin/content/homepage — current content (defaults filled in) + the defaults and limits for the form
export const getHomepage = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: { content: await getHomepageContent(), defaults: HOMEPAGE_DEFAULTS, limits: LIMITS } });
});

// PUT /api/admin/content/homepage — save hero + announcement bar (the storefront rebuilds itself)
export const updateHomepage = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  let input;
  try {
    input = validateHomepageInput(req.body, config.cloudinary.cloudName);
  } catch (err: any) {
    if (err instanceof ContentInputError) return next(new AppError(err.message, 400));
    throw err;
  }
  const user = (req as any).user;
  const content = await saveHomepageContent(input, user?.email || 'admin');
  res.status(200).json({ success: true, message: 'Homepage saved. The live site updates in a few minutes.', data: { content } });
});

// POST /api/admin/content/homepage/image — upload a hero image (multipart field "file")
export const uploadHomepageImage = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) return next(new AppError('No file uploaded', 400));
  const result = await uploadImageBuffer(req.file.buffer, 'homepage');
  res.status(200).json({
    success: true,
    data: { image: { url: result.secure_url, width: result.width, height: result.height } },
  });
});
