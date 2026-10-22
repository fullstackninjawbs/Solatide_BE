import { Router } from 'express';
import { getMetaPixelConfig, relayMetaEvent } from '../controllers/meta.controller';

const router = Router();

router.get('/config', getMetaPixelConfig);
router.post('/events', relayMetaEvent);

export default router;
