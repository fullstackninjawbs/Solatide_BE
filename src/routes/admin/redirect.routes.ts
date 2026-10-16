import { Router } from 'express';
import { listRedirects, createRedirect, updateRedirect } from '../../controllers/admin/redirectController';

const router = Router();

// protect + role check applied in routes/admin/index.ts. No delete: redirects are disabled, never removed.
router.get('/', listRedirects);
router.post('/', createRedirect);
router.patch('/:id', updateRedirect);

export default router;
