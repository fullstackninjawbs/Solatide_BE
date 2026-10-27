/**
 * Central role definitions + per-area access matrix.
 * Mirrors the admin UI menu matrix in Client/src/layouts/AdminLayout.jsx.
 * Change access here, not inline in routers.
 */
export type Role = 'super_admin' | 'operations' | 'content_manager' | 'support' | 'user' | 'admin';

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  OPERATIONS: 'operations',
  CONTENT_MANAGER: 'content_manager',
  SUPPORT: 'support',
  USER: 'user',
} as const;

/** Every non-customer role. */
export const STAFF_ROLES: Role[] = ['super_admin', 'admin', 'operations', 'content_manager', 'support'];

export const isStaffRole = (role: unknown): boolean =>
  typeof role === 'string' && (STAFF_ROLES as string[]).includes(role);

/** Route-group access lists (used with restrictTo(...ACCESS.x)). */
export const ACCESS = {
  /** Admin dashboard landing page — every staff role. */
  dashboard: ['super_admin', 'operations', 'content_manager', 'support', 'admin'] as Role[],

  orders: ['super_admin', 'operations', 'support', 'admin'] as Role[],
  orderShipping: ['super_admin', 'operations', 'admin'] as Role[],
  orderRefund: ['super_admin', 'admin'] as Role[],
  /** delete/restore/bulk, manual order create, payment-status edits */
  orderPrivileged: ['super_admin', 'admin'] as Role[],

  customers: ['super_admin', 'operations', 'support', 'admin'] as Role[],

  discounts: ['super_admin', 'operations', 'admin'] as Role[],
  discountDelete: ['super_admin'] as Role[],

  content: ['super_admin', 'content_manager', 'admin'] as Role[],

  reviews: ['super_admin', 'operations', 'support', 'admin'] as Role[],
  reviewsManage: ['super_admin', 'operations', 'admin'] as Role[],
  subscribers: ['super_admin', 'operations', 'admin'] as Role[],

  analytics: ['super_admin', 'operations', 'admin'] as Role[],

  settingsRead: ['super_admin', 'admin'] as Role[],
  settingsStoreWrite: ['super_admin', 'admin'] as Role[],
  settingsPayment: ['super_admin'] as Role[],

  shippingPackages: ['super_admin', 'admin'] as Role[],
  shippingPackageDelete: ['super_admin'] as Role[],


  /** Existing restrictions preserved from the previous routers. */
  products: ['admin', 'super_admin', 'operations', 'content_manager'] as Role[],
  productWrite: ['admin', 'super_admin', 'operations'] as Role[],
  productDestroy: ['super_admin'] as Role[],
  productImport: ['super_admin', 'operations', 'admin'] as Role[],
  publicProductDelete: ['super_admin', 'admin'] as Role[],
  batches: ['admin', 'super_admin'] as Role[],
  collections: ['admin', 'super_admin', 'content_manager', 'operations'] as Role[],
  adminUsers: ['super_admin', 'admin'] as Role[],
  superAdminOnly: ['super_admin'] as Role[],
};

/**
 * Roles the Admin Users screen can create/assign (the UI offers only these two).
 * These are also the roles counted against MAX_ADMIN_USERS.
 */
export const ADMIN_USER_ROLES: Role[] = ['super_admin', 'admin'];

/** Max number of super_admin/admin accounts. */
export const MAX_ADMIN_USERS = parseInt(process.env.MAX_ADMIN_USERS || '3', 10);
