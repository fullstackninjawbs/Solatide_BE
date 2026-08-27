import { Router } from 'express';
import * as pageController from '../controllers/cms.page.controller';

const router = Router();

// ─── PUBLIC ROUTES ───
// These will be mounted under /api/pages

router.get('/:slug', pageController.getPageBySlug);

export default router;
