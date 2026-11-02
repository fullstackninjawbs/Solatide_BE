import { Router } from 'express';
import * as contentController from '../controllers/content.controller';

const router = Router();

router.get('/faqs', contentController.getPublicFaqSections);
router.get('/homepage', contentController.getPublicHomepage);

export default router;
