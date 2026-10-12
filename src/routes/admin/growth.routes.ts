import express from 'express';
import * as growthController from '../../controllers/admin/growthController';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();
// protect applied in routes/admin/index.ts. Admin review moderation lives at
// /api/v1/reviews (see routes/review.routes.ts).

router.get('/subscribers', restrictTo(...ACCESS.subscribers), growthController.getSubscribers);
router.delete('/subscribers/:id', restrictTo(...ACCESS.subscribers), growthController.deleteSubscriber);
router.get('/', restrictTo(...ACCESS.reviews), growthController.getPlaceholder);

export default router;
