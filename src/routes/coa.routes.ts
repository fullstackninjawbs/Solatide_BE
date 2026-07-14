import { Router } from 'express';
import { getPublicCoas } from '../controllers/batch.controller';

const router = Router();

// Public Route to fetch COA documents
router.get('/', getPublicCoas);

export default router;
