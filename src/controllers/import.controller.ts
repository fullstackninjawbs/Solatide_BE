import { Request, Response, NextFunction } from 'express';
import { Readable } from 'stream';
import Product from '../models/product.model';
import { parseCsvProducts } from '../utils/csvToProducts';
import catchAsync from '../utils/catchAsync';
import AppError from '../utils/appError';

/**
 * Endpoint to preview CSV import file
 * POST /api/v1/admin/products/import/preview
 */
export const importProductsPreview = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) {
    return next(new AppError('Please upload a CSV file.', 400));
  }

  // Convert buffer to readable stream
  const stream = Readable.from(req.file.buffer);
  
  try {
    const parseResult = await parseCsvProducts(stream);
    
    // Slice first 5 mapped products for the UI preview table
    const productsPreview = parseResult.products.slice(0, 5);

    res.status(200).json({
      success: true,
      data: {
        productsCount: parseResult.productsCount,
        variantsCount: parseResult.variantsCount,
        errors: parseResult.errors,
        productsPreview
      }
    });
  } catch (err: any) {
    return next(new AppError(`Error parsing CSV file: ${err.message}`, 400));
  }
});

/**
 * Endpoint to commit CSV import to database
 * POST /api/v1/admin/products/import/commit
 */
export const importProductsCommit = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) {
    return next(new AppError('Please upload a CSV file.', 400));
  }

  const mode = req.body.mode || 'upsertByHandle'; // createOnly | upsertByHandle | skipExisting
  const publishDefault = req.body.publishDefault !== 'false';

  const stream = Readable.from(req.file.buffer);
  let parseResult;

  try {
    parseResult = await parseCsvProducts(stream);
  } catch (err: any) {
    return next(new AppError(`Error parsing CSV file: ${err.message}`, 400));
  }

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const commitErrors: any[] = [];

  // Query highest existing product ID to prevent numeric collisions
  const lastProduct = await Product.findOne().sort({ id: -1 });
  let nextNumericId = (lastProduct?.id || 0) + 1;

  // Process items sequentially to ensure ID safety and detailed audit logs
  for (const parsedProduct of parseResult.products) {
    try {
      let existing = await Product.findOne({ slug: parsedProduct.slug });

      if (existing) {
        if (mode === 'createOnly') {
          skippedCount++;
          commitErrors.push({
            handle: parsedProduct.slug,
            message: `Skipped: Product with handle "${parsedProduct.slug}" already exists (createOnly mode).`
          });
          continue;
        }

        if (mode === 'skipExisting') {
          skippedCount++;
          continue;
        }

        // upsertByHandle: Update existing product details
        existing.name = parsedProduct.name;
        existing.description = parsedProduct.description;
        existing.category = parsedProduct.category;
        existing.vendor = parsedProduct.vendor;
        existing.tag = parsedProduct.tag || existing.tag;
        existing.ratingCount = parsedProduct.ratingCount;
        existing.overviewHtml = parsedProduct.overviewHtml;
        existing.summaryHtml = parsedProduct.summaryHtml;
        existing.researchApplicationsHtml = parsedProduct.researchApplicationsHtml;
        
        if (parsedProduct.technicalSpecs) {
          existing.technicalSpecs = { rawHtml: parsedProduct.technicalSpecs.rawHtml };
        }
        
        if (parsedProduct.seo) {
          existing.seo = parsedProduct.seo;
        }

        // Replace variants and images arrays
        existing.variants = parsedProduct.variants;
        existing.images = parsedProduct.images;

        // Keep root properties synced
        existing.price = parsedProduct.price;
        existing.sku = parsedProduct.sku;
        existing.tagadaVariantId = parsedProduct.tagadaVariantId;
        existing.stockQuantity = parsedProduct.stockQuantity;
        existing.imageUrl = parsedProduct.imageUrl;
        existing.inStock = parsedProduct.inStock;
        existing.status = parsedProduct.status;

        await existing.save();
        updatedCount++;
      } else {
        // Create new Product record
        const newProductData = {
          ...parsedProduct,
          id: nextNumericId++,
          published: publishDefault
        };

        await Product.create(newProductData);
        createdCount++;
      }
    } catch (err: any) {
      commitErrors.push({
        handle: parsedProduct.slug,
        message: `Database error: ${err.message}`
      });
    }
  }

  // Combine parser warnings and database writing conflicts
  const allErrors = [...parseResult.errors, ...commitErrors];

  res.status(200).json({
    success: true,
    data: {
      created: createdCount,
      updated: updatedCount,
      skipped: skippedCount,
      errors: allErrors
    }
  });
});
