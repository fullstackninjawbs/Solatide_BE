import express from 'express';
import * as contentController from '../../controllers/admin/contentController';
import * as pageController from '../../controllers/cms.page.controller';
import * as homepageController from '../../controllers/admin/homepageController';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';
import { productImageUpload } from '../../middleware/uploadFilters';

const router = express.Router();

// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.content));

// FAQ Management Routes
router.route('/faqs')
  .get(contentController.getFaqSections)
  .post(contentController.createFaqSection);

router.route('/faqs/:id')
  .put(contentController.updateFaqSection)
  .delete(restrictTo('super_admin'), contentController.deleteFaqSection);

// Homepage hero + announcement bar
router.route('/homepage')
  .get(homepageController.getHomepage)
  .put(homepageController.updateHomepage);
router.post('/homepage/image', productImageUpload.single('file'), homepageController.uploadHomepageImage);

// Custom Pages Routes
router.route('/pages')
  .get(pageController.getAllPages)
  .post(pageController.createPage);

router.route('/pages/:id')
  .get(pageController.getPageById)
  .patch(pageController.updatePage)
  .delete(restrictTo('super_admin', 'admin', 'content_manager'), pageController.deletePage);

export default router;
