import { Router } from 'express';
import { resolveRedirect } from '../controllers/redirect.controller';

const router = Router();

// Public: nginx's @resolve fallback (X-Original-URI) and the storefront app (?path=&format=json)
router.get('/resolve', resolveRedirect);

export default router;
