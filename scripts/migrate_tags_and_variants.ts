/**
 * Migration Script: Migrate tags and variant currentBatchId
 *
 * Run with: npx ts-node scripts/migrate_tags_and_variants.ts
 * Dry run:  npx ts-node scripts/migrate_tags_and_variants.ts --dry-run
 *
 * What it does:
 *  1. Splits product.tag (string) -> product.tags[] (array)
 *  2. Copies product.currentBatchId -> product.variants[0].currentBatchId
 *  3. Auto-generates product.slug from product.name where missing
 *  4. Sets product.publishStatus based on product.published boolean
 */

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

import mongoose from 'mongoose';
import Product from '../src/models/product.model';

const DRY_RUN = process.argv.includes('--dry-run');

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

async function run() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!mongoUri) throw new Error('MONGO_URI or MONGODB_URI not set in .env');

  console.log('🔗 Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('✅ Connected!\n');

  const products = await Product.find({});
  console.log(`📦 Found ${products.length} products to migrate.\n`);

  let updated = 0;
  let skipped = 0;

  for (const product of products) {
    let changed = false;
    const changes: string[] = [];

    // 1) tags[] from tag string
    if (!product.tags || product.tags.length === 0) {
      const rawTag = (product as any).tag as string | undefined;
      if (rawTag && rawTag.trim()) {
        const parsedTags = rawTag.split(',').map((t: string) => t.trim()).filter(Boolean);
        (product as any).tags = parsedTags;
        changed = true;
        changes.push(`tags: ${JSON.stringify(parsedTags)}`);
      } else {
        (product as any).tags = [];
      }
    }

    // 2) slug auto-generation
    if (!product.slug) {
      const newSlug = slugify(product.name || '');
      (product as any).slug = newSlug;
      changed = true;
      changes.push(`slug: "${newSlug}"`);
    }

    // 3) publishStatus from published boolean
    if (!(product as any).publishStatus) {
      const ps = product.published !== false ? 'active' : 'draft';
      (product as any).publishStatus = ps;
      changed = true;
      changes.push(`publishStatus: "${ps}"`);
    }

    // 4) Copy root currentBatchId -> variants[0].currentBatchId
    const rootBatchId = (product as any).currentBatchId;
    if (rootBatchId && product.variants && product.variants.length > 0) {
      if (!(product.variants[0] as any).currentBatchId) {
        (product.variants[0] as any).currentBatchId = rootBatchId;
        changed = true;
        changes.push(`variants[0].currentBatchId = ${rootBatchId}`);
      }
    }

    if (changed) {
      console.log(`  [${product.name}]`);
      changes.forEach(c => console.log(`    → ${c}`));
      if (!DRY_RUN) {
        await product.save();
      }
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`\n✅ Migration complete.`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped: ${skipped}`);
  if (DRY_RUN) {
    console.log(`\n⚠️  DRY RUN — no changes were written to DB.`);
  }

  await mongoose.disconnect();
  console.log('🔌 Disconnected.');
}

run().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
