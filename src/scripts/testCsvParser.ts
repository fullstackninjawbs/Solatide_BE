import { Readable } from 'stream';
import { parseCsvProducts } from '../utils/csvToProducts';

// Mock CSV string resembling Shopify's product catalog format
const mockCsvData = `Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price,Variant Inventory Qty,Variant Inventory Policy,Variant Requires Shipping,Variant Taxable,Variant Grams,Image Src,Image Position,Image Alt Text,SEO Title,SEO Description
cagrisema-10mg,CagriSema 10mg,<p>Premium compound listing</p>,Solatide Biosciences,Research Peptides,"research blend, cagrisema",TRUE,Size,10mg,SOL-CAG-10M,149.95,199.95,10,deny,TRUE,TRUE,0.01,https://cloudinary.com/cagrisema_vial.png,1,CagriSema Front,Buy CagriSema Online,CagriSema 10mg peptide research
cagrisema-10mg,,,,,,,,Variant-2,SOL-CAG-10M-V2,139.95,,5,deny,TRUE,TRUE,0.01,https://cloudinary.com/cagrisema_vial_side.png,2,CagriSema Side,,
cagrilintide-5mg,Cagrilintide 5mg,<p>Cagrilintide peptide</p>,Solatide Biosciences,Research Peptides,"cagrilintide",TRUE,Size,5mg,SOL-CGL-5M,99.00,,7,deny,TRUE,TRUE,0.01,https://cloudinary.com/cagrilintide.png,1,Cagrilintide Vial,Buy Cagrilintide,Cagrilintide 5mg research
`;

const runTests = async () => {
  console.log('[Test] Initiating CSV parser unit tests...');
  
  const stream = Readable.from(mockCsvData);
  
  try {
    const result = await parseCsvProducts(stream);
    
    // Assertions
    console.log(`[Test] Products parsed: ${result.productsCount} (Expected: 2)`);
    console.log(`[Test] Variants parsed: ${result.variantsCount} (Expected: 3)`);
    
    if (result.productsCount !== 2) {
      throw new Error(`Assertion failed: Expected 2 products, got ${result.productsCount}`);
    }

    if (result.variantsCount !== 3) {
      throw new Error(`Assertion failed: Expected 3 variants, got ${result.variantsCount}`);
    }

    // Check CagriSema details
    const cagrisema = result.products.find(p => p.slug === 'cagrisema-10mg');
    if (!cagrisema) {
      throw new Error('Assertion failed: cagrisema-10mg not found in parsed products');
    }

    console.log('[Test] Validating CagriSema grouping and variants...');
    if (cagrisema.name !== 'CagriSema 10mg') {
      throw new Error(`Assertion failed: Expected name "CagriSema 10mg", got "${cagrisema.name}"`);
    }

    if (cagrisema.variants.length !== 2) {
      throw new Error(`Assertion failed: Expected cagrisema to have 2 variants, got ${cagrisema.variants.length}`);
    }

    // Validate prices
    if (cagrisema.variants[0].price !== 149.95 || cagrisema.variants[1].price !== 139.95) {
      throw new Error('Assertion failed: CagriSema variant prices mapped incorrectly');
    }

    // Validate root price fallback (first variant)
    if (cagrisema.price !== 149.95) {
      throw new Error(`Assertion failed: Expected root price 149.95, got ${cagrisema.price}`);
    }

    // Validate images sorting and positions
    console.log('[Test] Validating image positions and sorting...');
    if (cagrisema.images.length !== 2) {
      throw new Error(`Assertion failed: Expected 2 images, got ${cagrisema.images.length}`);
    }
    
    if (cagrisema.images[0].position !== 1 || cagrisema.images[1].position !== 2) {
      throw new Error('Assertion failed: Product images sorted incorrectly');
    }

    // Check Cagrilintide details
    const cagrilintide = result.products.find(p => p.slug === 'cagrilintide-5mg');
    if (!cagrilintide) {
      throw new Error('Assertion failed: cagrilintide-5mg not found in parsed products');
    }

    console.log('[Test] Validating Cagrilintide attributes...');
    if (cagrilintide.variants.length !== 1) {
      throw new Error(`Assertion failed: Expected 1 variant for cagrilintide, got ${cagrilintide.variants.length}`);
    }

    if (cagrilintide.price !== 99.00) {
      throw new Error(`Assertion failed: Expected cagrilintide price 99.00, got ${cagrilintide.price}`);
    }

    console.log('✓ [SUCCESS] All CSV parser unit tests passed successfully.');
    process.exit(0);
  } catch (err: any) {
    console.error('✗ [FAILURE] Tests failed:', err.message);
    process.exit(1);
  }
};

runTests();
