import path from 'path';
import multer from 'multer';
import { Request } from 'express';
import AppError from '../utils/appError';

type FileFilter = NonNullable<multer.Options['fileFilter']>;

/**
 * Build a multer fileFilter that requires BOTH an allowed MIME type and a
 * matching file extension.
 */
const makeFilter = (allowed: Record<string, string[]>, label: string): FileFilter =>
  (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const exts = allowed[(file.mimetype || '').toLowerCase()];
    if (exts && exts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new AppError(`Invalid file type. Allowed: ${label}.`, 400));
    }
  };

export const IMAGE_TYPES: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
};

export const imageFileFilter = makeFilter(IMAGE_TYPES, 'JPEG, PNG, WebP, GIF');

export const pdfOrImageFileFilter = makeFilter(
  { ...IMAGE_TYPES, 'application/pdf': ['.pdf'] },
  'PDF, JPEG, PNG, WebP, GIF'
);

/** CSV / XLSX imports (browsers report CSV with several MIME types). */
export const spreadsheetFileFilter = makeFilter(
  {
    'text/csv': ['.csv'],
    'application/csv': ['.csv'],
    'text/plain': ['.csv'],
    'application/vnd.ms-excel': ['.csv', '.xls'],
    'application/octet-stream': ['.csv', '.xlsx'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  },
  'CSV, XLSX'
);

/** Shared multer instances. */
export const reviewImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 20, fieldSize: 20 * 1024 },
  fileFilter: imageFileFilter,
});

export const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: imageFileFilter,
});

export const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: spreadsheetFileFilter,
});
