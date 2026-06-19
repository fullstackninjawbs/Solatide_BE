import csvParser from 'csv-parser';
import { Readable } from 'stream';

export interface IParsedVariant {
  title: string;
  sku: string;
  price: number;
  compareAtPrice?: number | null;
  stockQty: number;
  inventoryPolicy: 'deny' | 'continue';
  requiresShipping: boolean;
  taxable: boolean;
  weightGrams?: number;
}

export interface IParsedImage {
  url: string;
  alt?: string;
  position?: number;
}

export interface IParsedProduct {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: string;
  vendor: string;
  tag: string;
  published: boolean;
  seo: {
    title: string;
    description: string;
    canonicalUrl?: string;
  };
  overviewHtml?: string;
  summaryHtml?: string;
  researchApplicationsHtml?: string;
  technicalSpecs?: {
    rawHtml?: string;
  };
  ratingCount: number;
  variants: IParsedVariant[];
  images: IParsedImage[];
  
  // Root compatibility properties
  price: number;
  sku: string;
  stockQuantity: number;
  imageUrl: string;
  inStock: boolean;
  status: 'In Stock' | 'Sold Out' | 'Sale';
}

export interface IParseIssue {
  row: number;
  handle?: string;
  field?: string;
  message: string;
}

export interface IParseResult {
  products: IParsedProduct[];
  variantsCount: number;
  productsCount: number;
  errors: IParseIssue[];
}

/**
 * Safely parse a readable stream of CSV rows into grouped products and variants
 */
export const parseCsvProducts = (stream: Readable): Promise<IParseResult> => {
  return new Promise((resolve, reject) => {
    const productMap = new Map<string, any>();
    const errors: IParseIssue[] = [];
    let rowIndex = 1; // Row 1 is header, first data row is 2
    let variantsCount = 0;

    stream
      .pipe(csvParser())
      .on('data', (row) => {
        rowIndex++;
        const rawHandle = row['Handle'];
        if (!rawHandle || !rawHandle.trim()) {
          errors.push({
            row: rowIndex,
            message: 'Skipped row: Handle is missing or blank.'
          });
          return;
        }

        const handle = rawHandle.trim();
        
        // Retrieve or create product structure for this handle
        if (!productMap.has(handle)) {
          const rawTitle = row['Title'];
          if (!rawTitle || !rawTitle.trim()) {
            errors.push({
              row: rowIndex,
              handle,
              field: 'Title',
              message: 'Warning: Handle initialization row is missing a product Title.'
            });
          }

          productMap.set(handle, {
            slug: handle,
            name: rawTitle?.trim() || '',
            description: row['Body (HTML)']?.trim() || '',
            category: row['Product Category']?.trim() || row['Type']?.trim() || 'Uncategorized',
            vendor: row['Vendor']?.trim() || 'Solatide Biosciences',
            tag: row['Tags']?.split(',').map((t: string) => t.trim()).filter(Boolean)[0] || '',
            published: row['Published']?.trim().toUpperCase() !== 'FALSE',
            seo: {
              title: row['SEO Title']?.trim() || '',
              description: row['SEO Description']?.trim() || '',
              canonicalUrl: ''
            },
            overviewHtml: row['product.metafields.custom.product_overview']?.trim() || row['product_overview']?.trim() || '',
            summaryHtml: row['product.metafields.custom.product_summary']?.trim() || row['product_summary']?.trim() || '',
            researchApplicationsHtml: row['product.metafields.custom.research_applications']?.trim() || row['research_applications']?.trim() || '',
            technicalSpecs: {
              rawHtml: row['product.metafields.custom.technical_specifications']?.trim() || row['technical_specifications']?.trim() || ''
            },
            ratingCount: parseInt(row['product.metafields.reviews.rating_count'] || row['rating_count'], 10) || 0,
            variants: [],
            images: [],
            id: 0
          });
        }

        const pObj = productMap.get(handle);

        // Accumulate missing fields if populated on subsequent rows
        if (!pObj.name && row['Title']) pObj.name = row['Title'].trim();
        if (!pObj.description && row['Body (HTML)']) pObj.description = row['Body (HTML)'].trim();

        // 1) Parse Variant details
        const variantSku = row['Variant SKU']?.trim();
        const rawPrice = row['Variant Price'];
        let price = parseFloat(rawPrice);
        if (isNaN(price)) {
          price = 0;
          if (rawPrice) {
            errors.push({
              row: rowIndex,
              handle,
              field: 'Variant Price',
              message: `Invalid price "${rawPrice}". Defaulting to 0.`
            });
          }
        }

        const rawCompare = row['Variant Compare At Price'];
        let compareAtPrice = rawCompare ? parseFloat(rawCompare) : null;
        if (rawCompare && isNaN(compareAtPrice as number)) {
          compareAtPrice = null;
          errors.push({
            row: rowIndex,
            handle,
            field: 'Variant Compare At Price',
            message: `Invalid compare-at price "${rawCompare}". Defaulting to null.`
          });
        }

        const rawQty = row['Variant Inventory Qty'];
        let stockQty = parseInt(rawQty, 10);
        if (isNaN(stockQty)) {
          stockQty = 0;
          if (rawQty) {
            errors.push({
              row: rowIndex,
              handle,
              field: 'Variant Inventory Qty',
              message: `Invalid stock quantity "${rawQty}". Defaulting to 0.`
            });
          }
        }

        const rawWeight = row['Variant Grams'];
        let weightGrams: number | undefined = rawWeight ? parseFloat(rawWeight) : undefined;
        if (rawWeight && isNaN(weightGrams as number)) {
          weightGrams = undefined;
        }

        const requiresShipping = row['Variant Requires Shipping']?.trim().toUpperCase() !== 'FALSE';
        const taxable = row['Variant Taxable']?.trim().toUpperCase() !== 'FALSE';
        const inventoryPolicy = row['Variant Inventory Policy']?.trim().toLowerCase() === 'continue' ? 'continue' : 'deny';

        // 1.5) Determine Variant Title from Options
        const opt1 = row['Option1 Value']?.trim() || '';
        const opt2 = row['Option2 Value']?.trim() || '';
        const opt3 = row['Option3 Value']?.trim() || '';
        const optionParts = [opt1, opt2, opt3].filter(Boolean);
        const variantTitle = optionParts.length > 0 ? optionParts.join(' / ') : 'Default Title';

        // Add variant if we have a SKU or price
        if (variantSku || rawPrice) {
          pObj.variants.push({
            title: variantTitle,
            sku: variantSku || `${handle}-var-${pObj.variants.length + 1}`,
            price,
            compareAtPrice,
            stockQty,
            inventoryPolicy,
            requiresShipping,
            taxable,
            weightGrams
          });
          variantsCount++;
        }

        // 2) Parse Image details
        const imgSrc = row['Image Src']?.trim();
        if (imgSrc) {
          const rawPos = row['Image Position'];
          let position = parseInt(rawPos, 10);
          if (isNaN(position)) {
            position = pObj.images.length + 1;
          }

          // Check for URL duplication
          const alreadyExists = pObj.images.some((img: any) => img.url === imgSrc);
          if (!alreadyExists) {
            pObj.images.push({
              url: imgSrc,
              alt: row['Image Alt Text']?.trim() || '',
              position
            });
          }
        }
      })
      .on('end', () => {
        const productsList: IParsedProduct[] = [];

        for (const [handle, pObj] of productMap.entries()) {
          // Validation: Product title check
          if (!pObj.name) {
            errors.push({
              row: 0,
              handle,
              message: `Validation Error: Product "${handle}" has no parsed Title name.`
            });
            pObj.name = handle.replace(/-/g, ' '); // fallback
          }

          // Sort images by position
          pObj.images.sort((a: any, b: any) => (a.position || 0) - (b.position || 0));

          // If no variants parsed, add a default variant
          if (pObj.variants.length === 0) {
            pObj.variants.push({
              title: 'Default Title',
              sku: `${handle}-default`,
              price: 0,
              compareAtPrice: null,
              stockQty: 0,
              inventoryPolicy: 'deny',
              requiresShipping: true,
              taxable: true
            });
          }

          // Aggregate Root properties for backward compatibility
          pObj.price = pObj.variants[0].price;
          pObj.sku = pObj.variants[0].sku;
          pObj.stockQuantity = pObj.variants.reduce((sum: number, v: any) => sum + v.stockQty, 0);
          pObj.imageUrl = pObj.images[0]?.url || '';
          pObj.inStock = pObj.stockQuantity > 0;
          pObj.status = pObj.inStock ? 'In Stock' : 'Sold Out';

          productsList.push(pObj);
        }

        resolve({
          products: productsList,
          variantsCount,
          productsCount: productsList.length,
          errors
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
};
