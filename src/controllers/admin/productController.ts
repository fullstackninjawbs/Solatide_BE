import { Request, Response, NextFunction } from 'express';
import {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  updateMediaAltText,
} from '../../controllers/product.controller';

// Re-export the full product controller under the admin namespace
export {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  updateMediaAltText,
};
