import express from 'express';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';
import {
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser
} from '../../controllers/admin/adminUserController';

const router = express.Router();

// Only super_admin or admin can manage admin users
// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.adminUsers));

router.get('/', getAdminUsers);
router.post('/', createAdminUser);
router.put('/:id', updateAdminUser);
router.delete('/:id', deleteAdminUser);

export default router;
