import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import User from '../../models/user.model';
import AppError from '../../utils/appError';
import catchAsync from '../../utils/catchAsync';
import { AuthenticatedRequest } from '../../middleware/auth';
import { ADMIN_USER_ROLES, MAX_ADMIN_USERS, STAFF_ROLES, Role } from '../../config/roles';
import { toSafeUser, validatePassword, markPasswordChanged } from '../auth.controller';

const isSuperAdmin = (req: AuthenticatedRequest) => req.user?.role === 'super_admin';
const normEmail = (email: unknown): string | null =>
  typeof email === 'string' && email.trim() && email.length <= 254 ? email.trim().toLowerCase() : null;

/**
 * GET /api/admin/users
 * List admin-console accounts (super_admin/admin)
 */
export const getAdminUsers = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const users = await User.find({ role: { $in: ADMIN_USER_ROLES } })
    .select('-password -passwordResetToken -passwordResetExpires')
    .sort('-createdAt');

  res.status(200).json({
    success: true,
    data: {
      users: users.map(toSafeUser),
      count: users.length,
      maxAllowed: MAX_ADMIN_USERS
    }
  });
});

/**
 * POST /api/admin/users
 * Create a new admin user.
 * - only super_admin may create a super_admin
 * - MAX_ADMIN_USERS enforced
 */
export const createAdminUser = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { name, password, role } = req.body || {};
  const email = normEmail(req.body?.email);

  if (typeof name !== 'string' || !name.trim() || !email || !password || !role) {
    return next(new AppError('Please provide name, email, password, and role', 400));
  }

  if (!ADMIN_USER_ROLES.includes(role)) {
    return next(new AppError('Invalid admin role', 400));
  }

  if (role === 'super_admin' && !isSuperAdmin(req)) {
    return next(new AppError('Only a super_admin can create a super_admin account', 403));
  }

  const pwError = validatePassword(password);
  if (pwError) return next(new AppError(pwError, 400));

  const adminCount = await User.countDocuments({ role: { $in: ADMIN_USER_ROLES } });
  if (adminCount >= MAX_ADMIN_USERS) {
    return next(new AppError(`Maximum limit of ${MAX_ADMIN_USERS} admin users reached. Cannot add more.`, 403));
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return next(new AppError('Email address is already in use', 400));
  }

  const newUser = await User.create({
    name: name.trim(),
    email,
    password,
    role
  });

  res.status(201).json({
    success: true,
    data: { user: toSafeUser(newUser) }
  });
});

/**
 * PUT /api/admin/users/:id
 * Update an existing admin user.
 * Rules (H-2):
 * - nobody can change their own role
 * - only super_admin can edit a super_admin, assign super_admin, or change another
 *   user's email / password / role
 * - target must be a staff account, unless a super_admin is explicitly promoting
 *   a customer by sending `role`
 * - promotions into super_admin/admin respect MAX_ADMIN_USERS
 */
export const updateAdminUser = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { name, role, password } = req.body || {};
  const email = req.body?.email !== undefined ? normEmail(req.body.email) : undefined;
  const userId = req.params.id;
  const actor = req.user!;
  const actorIsSuper = isSuperAdmin(req);
  const isSelf = String(actor._id) === String(userId);

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return next(new AppError('User not found', 404));
  }

  const userToUpdate = await User.findById(userId);
  if (!userToUpdate) {
    return next(new AppError('User not found', 404));
  }

  const targetIsStaff = (STAFF_ROLES as string[]).includes(userToUpdate.role);
  const roleChanging = role !== undefined && role !== null && role !== '' && role !== userToUpdate.role;

  if (!targetIsStaff) {
    // Customer accounts are not managed here, except explicit promotion by super_admin
    if (!(actorIsSuper && roleChanging)) {
      return next(new AppError('User not found', 404));
    }
  }

  if (userToUpdate.role === 'super_admin' && !actorIsSuper) {
    return next(new AppError('Only a super_admin can modify a super_admin account', 403));
  }

  if (roleChanging) {
    if (isSelf) {
      return next(new AppError('You cannot change your own role', 403));
    }
    if (!actorIsSuper) {
      return next(new AppError('Only a super_admin can change user roles', 403));
    }
    if (!ADMIN_USER_ROLES.includes(role as Role)) {
      return next(new AppError('Invalid admin role', 400));
    }
    // Promotion into the admin-user pool counts against the cap
    if (!ADMIN_USER_ROLES.includes(userToUpdate.role)) {
      const adminCount = await User.countDocuments({ role: { $in: ADMIN_USER_ROLES } });
      if (adminCount >= MAX_ADMIN_USERS) {
        return next(new AppError(`Maximum limit of ${MAX_ADMIN_USERS} admin users reached. Cannot add more.`, 403));
      }
    }
    // Never demote the last super_admin
    if (userToUpdate.role === 'super_admin') {
      const superAdminCount = await User.countDocuments({ role: 'super_admin' });
      if (superAdminCount <= 1) {
        return next(new AppError('Cannot change the role of the only super_admin', 403));
      }
    }
  }

  if (!isSelf && !actorIsSuper && ((email !== undefined && email !== userToUpdate.email) || password)) {
    return next(new AppError("Only a super_admin can change another user's email or password", 403));
  }

  if (email !== undefined) {
    if (!email) return next(new AppError('Invalid email address', 400));
    if (email !== userToUpdate.email) {
      const existing = await User.findOne({ email });
      if (existing) {
        return next(new AppError('Email address is already in use', 400));
      }
      userToUpdate.email = email;
    }
  }

  if (typeof name === 'string' && name.trim()) userToUpdate.name = name.trim();

  if (roleChanging) {
    userToUpdate.role = role as any;
  }

  if (password) {
    const pwError = validatePassword(password);
    if (pwError) return next(new AppError(pwError, 400));
    userToUpdate.password = password; // hashed by pre-save hook
    markPasswordChanged(userToUpdate);
  }

  await userToUpdate.save();

  res.status(200).json({
    success: true,
    data: { user: toSafeUser(userToUpdate) }
  });
});

/**
 * DELETE /api/admin/users/:id
 * Delete an admin user (super_admin only)
 */
export const deleteAdminUser = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const userId = req.params.id;
  const currentUserId = req.user?._id?.toString();

  if (userId === currentUserId) {
    return next(new AppError('You cannot delete your own account', 400));
  }

  // Only super_admin can delete users
  if (!isSuperAdmin(req)) {
    return next(new AppError('Only super_admin can delete admin users', 403));
  }

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return next(new AppError('User not found', 404));
  }

  const userToDelete = await User.findById(userId);
  if (!userToDelete || !(STAFF_ROLES as string[]).includes(userToDelete.role)) {
    return next(new AppError('User not found', 404));
  }

  if (userToDelete.role === 'super_admin') {
    const superAdminCount = await User.countDocuments({ role: 'super_admin' });
    if (superAdminCount <= 1) {
      return next(new AppError('Cannot delete the only super_admin in the system', 403));
    }
  }

  await User.findByIdAndDelete(userId);

  res.status(200).json({
    success: true,
    data: null
  });
});
