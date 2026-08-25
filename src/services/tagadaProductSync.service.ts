import { getTagadaClient } from './tagadaClient';
import Product from '../models/product.model';
import TagadaProductSyncLog from '../models/tagadaProductSyncLog.model';
import { LOCAL_OWNED_PRODUCT_FIELDS, TAGADA_OWNED_PRODUCT_FIELDS } from '../config/tagadaProductSync.config';
import { cacheDel } from '../utils/cache';
import config from '../config';

/**
 * Fetch all products from Tagada using pagination.
 */
export async function fetchTagadaProducts(): Promise<any[]> {
  const client = await getTagadaClient();
  let allProducts: any[] = [];
  let hasMore = true;
  let page = 1;

  while (hasMore) {
    try {
      // Pass storeId as required by Tagada SDK
      const response = await client.products.list({
        storeId: config.tagadaStoreId,
        page,
        limit: 100,
        includeVariants: true
      });

      // Tagada SDK usually returns an object like { data: [...], has_more: boolean } or similar
      const products = response.data || response;
      if (Array.isArray(products)) {
        allProducts = allProducts.concat(products);
      } else if (response.items && Array.isArray(response.items)) {
        allProducts = allProducts.concat(response.items);
      } else {
        break;
      }

      if (products.length < 100 || response.has_more === false) {
        hasMore = false;
      } else {
        page++;
      }
    } catch (error: any) {
      console.error('[TagadaSync] Error fetching products from Tagada', error.message);
      throw error;
    }
  }

  return allProducts;
}

/**
 * Normalize raw Tagada product to match the local Product schema.
 */
export function normalizeTagadaProduct(raw: any): Partial<any> {
  const defaultCurrency = config.tagadaDefaultCurrency || 'AUD';

  const extractPrice = (priceObj: any) => {
    if (typeof priceObj === 'number') return priceObj / 100;
    if (priceObj?.currencyOptions?.[defaultCurrency]?.amount) {
      return priceObj.currencyOptions[defaultCurrency].amount / 100;
    }
    // Fallback if structure varies
    if (priceObj?.amount) return priceObj.amount / 100;
    return 0;
  };

  const normalized: any = {
    name: raw.name,
    description: raw.description,
    price: extractPrice(raw.price),
    compareAtPrice: extractPrice(raw.compare_at_price || raw.compareAtPrice),
    publishStatus: raw.active || raw.status === 'active' ? 'active' : 'draft',
    tagadaProductId: raw.id,
    sku: raw.sku || (raw.variants && raw.variants.length > 0 ? raw.variants[0].sku : '') || '',
    imageUrl: raw.images && raw.images.length > 0 ? raw.images[0] : (raw.image || undefined),
    stockQuantity: raw.inventory_quantity || 0,
    inStock: raw.inventory_quantity > 0 || !raw.tracks_inventory,
  };

  // Map variants if available
  if (raw.variants && Array.isArray(raw.variants) && raw.variants.length > 0) {
    normalized.variants = raw.variants.map((v: any) => ({
      title: v.name || v.title,
      sku: v.sku || '',
      price: extractPrice(v.price) || normalized.price,
      compareAtPrice: extractPrice(v.compare_at_price || v.compareAtPrice) || normalized.compareAtPrice,
      stockQty: v.inventory_quantity || 0,
      inventoryPolicy: v.inventory_policy || 'deny',
      requiresShipping: v.requires_shipping !== false,
      taxable: v.taxable !== false,
      weightGrams: v.weight_grams || v.weight || 0,
      tagadaVariantId: v.id,
      tagadaUpdatedAt: new Date(),
    }));

    // Set the root tagadaVariantId to the first variant's ID if present
    normalized.tagadaVariantId = raw.variants[0].id;
  } else {
    normalized.variants = [];
    normalized.tagadaVariantId = raw.default_variant_id || raw.id; // Fallback if no variants array
  }

  return normalized;
}

/**
 * Sync a single product record into the local DB.
 */
export async function syncTagadaProduct(tagadaProduct: any): Promise<any> {
  const normalized = normalizeTagadaProduct(tagadaProduct);
  const now = new Date();

  // Try to find existing product by Tagada ID
  let localProduct = await Product.findOne({ tagadaProductId: normalized.tagadaProductId });

  // If not found by ID, try matching by Exact Name (case-insensitive) to link existing products
  if (!localProduct && normalized.name) {
    const escapedName = normalized.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRegex = new RegExp(`^${escapedName}$`, 'i');
    localProduct = await Product.findOne({ name: nameRegex });
    if (localProduct) {
      // Link the ID so we know it's the same product in the future
      localProduct.tagadaProductId = normalized.tagadaProductId;
      await localProduct.save();
    }
  }

  if (localProduct) {
    let updated = false;

    // Update root fields from Tagada
    const rootFieldsToUpdate = ['name', 'price', 'sku', 'tagadaVariantId'];

    for (const field of rootFieldsToUpdate) {
      if ((normalized as any)[field] !== undefined && (localProduct as any)[field] !== (normalized as any)[field]) {
        (localProduct as any)[field] = (normalized as any)[field];
        updated = true;
      }
    }

    // Update variants from Tagada
    if (normalized.variants && normalized.variants.length > 0) {
      const tagadaVariant = normalized.variants[0];

      // Ensure localProduct has a variants array
      if (!localProduct.variants) {
        localProduct.variants = [];
      }

      // If the local product doesn't have a variant yet, add it
      if (localProduct.variants.length === 0) {
        localProduct.variants.push(tagadaVariant);
        updated = true;
      } else {
        // Update the first variant with Tagada data
        const localVariant = localProduct.variants[0];
        const variantFieldsToUpdate = ['title', 'sku', 'price', 'tagadaVariantId'];

        for (const field of variantFieldsToUpdate) {
          if ((tagadaVariant as any)[field] !== undefined && (localVariant as any)[field] !== (tagadaVariant as any)[field]) {
            (localVariant as any)[field] = (tagadaVariant as any)[field];
            updated = true;
          }
        }
      }
    }

    if (updated) {
      localProduct.tagadaSync = {
        lastSyncedAt: now,
        tagadaUpdatedAt: tagadaProduct.updated_at ? new Date(tagadaProduct.updated_at) : now,
        syncStatus: 'synced'
      };
      await localProduct.save();
      return { action: 'updated', product: localProduct };
    }

    return { action: 'skipped', product: localProduct };
  }

  // Create new product if no match found at all
  try {
    const nextIdRecord = await Product.findOne().sort({ id: -1 }).select('id');
    const nextId = (nextIdRecord?.id || 0) + 1;

    const newProductData = {
      ...normalized,
      id: nextId,
      slug: normalized.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      source: 'tagada',
      category: 'Uncategorized',
      researchCategory: 'laboratory-support',
      tags: [],
      tagadaSync: {
        lastSyncedAt: now,
        tagadaUpdatedAt: tagadaProduct.updated_at ? new Date(tagadaProduct.updated_at) : now,
        syncStatus: 'synced',
      }
    };

    const created = await Product.create(newProductData);
    return { action: 'created', product: created };
  } catch (error: any) {
    return { action: 'failed', error: error.message };
  }
}

/**
 * Preview product changes without writing to DB.
 */
export async function previewTagadaProductSync(): Promise<any> {
  const products = await fetchTagadaProducts();
  const changes = [];

  for (const raw of products) {
    const normalized = normalizeTagadaProduct(raw);
    const localProduct = await Product.findOne({ tagadaProductId: normalized.tagadaProductId });

    if (!localProduct) {
      changes.push({
        tagadaProductId: normalized.tagadaProductId,
        productName: normalized.name,
        action: 'created'
      });
    } else {
      // Simple diff
      const changedFields = [];
      if (localProduct.name !== normalized.name) changedFields.push('name');
      if (localProduct.price !== normalized.price) changedFields.push('price');
      if (localProduct.sku !== normalized.sku) changedFields.push('sku');
      if (localProduct.tagadaVariantId !== normalized.tagadaVariantId) changedFields.push('tagadaVariantId');

      changes.push({
        tagadaProductId: normalized.tagadaProductId,
        localProductId: localProduct._id,
        productName: normalized.name,
        action: changedFields.length > 0 ? 'updated' : 'skipped',
        changedFields
      });
    }
  }

  return changes;
}

/**
 * Run a full sync on all Tagada products and record the log.
 */
export async function syncAllTagadaProducts(adminUserId: any): Promise<any> {
  const log = new TagadaProductSyncLog({
    initiatedBy: adminUserId,
    syncType: 'full',
    startedAt: new Date(),
    status: 'running',
    changes: []
  });
  await log.save();

  try {
    const products = await fetchTagadaProducts();
    log.totalFetched = products.length;

    for (const raw of products) {
      const result = await syncTagadaProduct(raw);

      const changeLog = {
        tagadaProductId: raw.id,
        localProductId: result.product?._id,
        productName: raw.name || 'Unknown',
        action: result.action,
        error: result.error
      };

      if (result.action === 'created') log.createdCount++;
      if (result.action === 'updated') log.updatedCount++;
      if (result.action === 'failed') log.failedCount++;

      log.changes.push(changeLog);
    }

    log.status = log.failedCount > 0 ? 'completed_with_errors' : 'completed';
    log.completedAt = new Date();
    await log.save();

    // Invalidate caches
    await cacheDel('products:list*');
    await cacheDel('products:detail*');

    return log;
  } catch (error: any) {
    log.status = 'failed';
    log.error = error.message;
    log.completedAt = new Date();
    await log.save();
    throw error;
  }
}
