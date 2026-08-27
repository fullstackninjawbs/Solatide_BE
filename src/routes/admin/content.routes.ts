import express from 'express';
import * as contentController from '../../controllers/admin/contentController';
import * as pageController from '../../controllers/cms.page.controller';
import { protect, restrictTo } from '../../middleware/auth';

const router = express.Router();

// All admin content routes require authentication
router.use(protect);

// FAQ Management Routes
router.route('/faqs')
  .get(contentController.getFaqSections)
  .post(contentController.createFaqSection);

router.route('/faqs/:id')
  .put(contentController.updateFaqSection)
  .delete(restrictTo('super_admin'), contentController.deleteFaqSection);

// Custom Pages Routes
router.route('/pages')
  .get(pageController.getAllPages)
  .post(pageController.createPage);

router.route('/pages/:id')
  .get(pageController.getPageById)
  .patch(pageController.updatePage)
  .delete(restrictTo('super_admin', 'admin', 'content_manager', 'operations'), pageController.deletePage);

export default router;
