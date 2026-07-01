import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import Collection from '../src/models/collection.model';
import Product from '../src/models/product.model';

const escapeRegex = (s: string) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

const buildQueryFromRules = (rules: any[], ruleRelation: 'all' | 'any') => {
  if (!rules || rules.length === 0) {
    return { _id: { $in: [] } };
  }

  const queries = rules.map(rule => {
    const { field, operator, value } = rule;
    let dbField = '';
    if (field === 'title') dbField = 'name';
    else if (field === 'type') dbField = 'category';
    else if (field === 'tag') dbField = 'tag';
    else if (field === 'vendor') dbField = 'vendor';
    else if (field === 'price') dbField = 'price';
    else if (field === 'compareAtPrice') dbField = 'compareAtPrice';
    else dbField = field;

    switch (operator) {
      case 'is equal to':
        if (dbField === 'price' || dbField === 'compareAtPrice') {
          return { [dbField]: Number(value) };
        }
        return { [dbField]: { $regex: `^${escapeRegex(value)}$`, $options: 'i' } };
      case 'is not equal to':
        if (dbField === 'price' || dbField === 'compareAtPrice') {
          return { [dbField]: { $ne: Number(value) } };
        }
        return { [dbField]: { $not: { $regex: `^${escapeRegex(value)}$`, $options: 'i' } } };
      case 'is greater than':
        return { [dbField]: { $gt: Number(value) } };
      case 'is less than':
        return { [dbField]: { $lt: Number(value) } };
      case 'starts with':
        return { [dbField]: { $regex: `^${escapeRegex(value)}`, $options: 'i' } };
      case 'ends with':
        return { [dbField]: { $regex: `${escapeRegex(value)}$`, $options: 'i' } };
      case 'contains':
        return { [dbField]: { $regex: escapeRegex(value), $options: 'i' } };
      case 'does not contain':
        return { [dbField]: { $not: { $regex: escapeRegex(value), $options: 'i' } } };
      default:
        return {};
    }
  });

  if (ruleRelation === 'any') {
    return { $or: queries };
  } else {
    return { $and: queries };
  }
};

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not found in env!');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('Connected!');

  // Test 1: Let's fetch one product to see the schema and data
  const sampleProduct = await Product.findOne();
  if (sampleProduct) {
    console.log('Sample Product:', {
      name: sampleProduct.name,
      category: sampleProduct.category,
      price: sampleProduct.price,
      tag: sampleProduct.tag
    });
  } else {
    console.log('No products found in DB.');
  }

  // Test 2: Build a test query for Price is greater than 0
  const rules = [{ field: 'price', operator: 'is greater than', value: '0' }];
  const query = buildQueryFromRules(rules, 'all');
  console.log('Computed Query:', JSON.stringify(query));
  
  const matchCount = await Product.countDocuments(query);
  console.log(`Products matching (Price > 0): ${matchCount}`);

  // Test 3: Create a test automated collection if it does not exist
  const testCollectionSlug = 'test-automated-peptides';
  await Collection.deleteOne({ slug: testCollectionSlug });
  
  const testCol = await Collection.create({
    name: 'Test Automated Peptides',
    slug: testCollectionSlug,
    description: '<p>Test automated collection description</p>',
    type: 'automated',
    ruleRelation: 'all',
    rules: [
      { field: 'price', operator: 'is greater than', value: '10' }
    ],
    status: 'active',
    displayOptions: { showFaqBlock: true }
  });
  console.log('Created Collection:', testCol.name, 'with slug:', testCol.slug);

  // Test 4: Verify the collection query returns matching products count
  const matchingQuery = buildQueryFromRules(testCol.rules, testCol.ruleRelation);
  const matchingProducts = await Product.find(matchingQuery).limit(5);
  console.log(`Matching Products for ${testCol.name} (Count: ${await Product.countDocuments(matchingQuery)}):`);
  matchingProducts.forEach((p: any) => console.log(` - ${p.name} (Price: ${p.price})`));

  // Clean up
  await Collection.deleteOne({ slug: testCollectionSlug });
  console.log('Cleaned up test collection.');

  await mongoose.disconnect();
  console.log('Disconnected from DB.');
}

main().catch(err => {
  console.error(err);
  mongoose.disconnect();
});
