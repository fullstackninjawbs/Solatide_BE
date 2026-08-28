import { Router } from 'express';
import * as pageController from '../controllers/cms.page.controller';

const router = Router();

// ─── ADMIN ROUTES (Requires Authentication & Admin Privileges) ───
// These will be mounted under /api/admin/pages
// Note: We are assuming that /api/admin routes already enforce admin authentication in index.ts
// If not, we should import and apply the middlewares here.

router.get('/', pageController.getAllPages);
router.post('/', pageController.createPage);
router.get('/:id', pageController.getPageById);
router.patch('/:id', pageController.updatePage);
router.delete('/:id', pageController.deletePage);

export default router;
