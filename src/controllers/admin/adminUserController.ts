import { Request, Response, NextFunction } from 'express';
import User from '../../models/user.model';
import AppError from '../../utils/appError';
import catchAsync from '../../utils/catchAsync';
import { AuthenticatedRequest } from '../../middleware/auth';

const ADMIN_ROLES = ['super_admin', 'admin'];
const MAX_ADMIN_USERS = 3;

/**
 * GET /api/admin/users
 * Get all admin users (roles other than 'user')
 */
export const getAdminUsers = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const users = await User.find({ role: { $in: ADMIN_ROLES } }).select('-password').sort('-createdAt');
  
  res.status(200).json({
    success: true,
    data: {
      users,
      count: users.length,
      maxAllowed: MAX_ADMIN_USERS
    }
  });
});

/**
 * POST /api/admin/users
 * Create a new admin user
 */
export const createAdminUser = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return next(new AppError('Please provide name, email, password, and role', 400));
  }

  if (!ADMIN_ROLES.includes(role)) {
    return next(new AppError('Invalid admin role', 400));
  }

  // Check current number of admin users
  const adminCount = await User.countDocuments({ role: { $in: ADMIN_ROLES } });
  if (adminCount >= MAX_ADMIN_USERS) {
    return next(new AppError(`Maximum limit of ${MAX_ADMIN_USERS} admin users reached. Cannot add more.`, 403));
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return next(new AppError('Email address is already in use', 400));
  }

  const newUser = await User.create({
    name,
    email,
    password,
    role
  });

  // Remove password from output
  newUser.password = undefined;

  res.status(201).json({
    success: true,
    data: { user: newUser }
  });
});

/**
 * PUT /api/admin/users/:id
 * Update an existing admin user
 */
export const updateAdminUser = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { name, email, role, password } = req.body;
  const userId = req.params.id;

  const userToUpdate = await User.findById(userId);
  if (!userToUpdate) {
    return next(new AppError('User not found', 404));
  }

  if (email && email !== userToUpdate.email) {
    const existing = await User.findOne({ email });
    if (existing) {
      return next(new AppError('Email address is already in use', 400));
    }
    userToUpdate.email = email;
  }

  if (name) userToUpdate.name = name;
  
  if (role) {
    if (!ADMIN_ROLES.includes(role)) {
      return next(new AppError('Invalid admin role', 400));
    }
    userToUpdate.role = role as any;
  }

  if (password) {
    userToUpdate.password = password; // Will be hashed by pre-save hook
  }

  await userToUpdate.save();

  userToUpdate.password = undefined;

  res.status(200).json({
    success: true,
    data: { user: userToUpdate }
  });
});

/**
 * DELETE /api/admin/users/:id
 * Delete an admin user
 */
export const deleteAdminUser = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const userId = req.params.id;
  const currentUserId = req.user?._id?.toString();

  if (userId === currentUserId) {
    return next(new AppError('You cannot delete your own account', 400));
  }

  const userToDelete = await User.findById(userId);
  if (!userToDelete) {
    return next(new AppError('User not found', 404));
  }

  if (userToDelete.role === 'super_admin') {
    // Check if it's the last super_admin
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
