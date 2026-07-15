import express from 'express';
import { protect, restrictTo } from '../../middleware/auth';
import {
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser
} from '../../controllers/admin/adminUserController';

const router = express.Router();

// Only super_admin or admin can manage admin users
router.use(protect);
router.use(restrictTo('super_admin', 'admin'));

router.get('/', getAdminUsers);
router.post('/', createAdminUser);
router.put('/:id', updateAdminUser);
router.delete('/:id', deleteAdminUser);

export default router;
