import express from 'express';
import * as contentController from '../../controllers/admin/contentController';

const router = express.Router();

// FAQ Management Routes
router.route('/faqs')
  .get(contentController.getFaqSections)
  .post(contentController.createFaqSection);

router.route('/faqs/:id')
  .put(contentController.updateFaqSection)
  .delete(contentController.deleteFaqSection);

export default router;
