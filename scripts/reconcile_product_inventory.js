const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }));
  
  const products = await Product.find({}).lean();
  console.log(`Found ${products.length} products to reconcile.`);

  let updatedCount = 0;

  for (const p of products) {
    let totalStock = 0;
    let canContinue = p.inventoryPolicy === 'continue' || p.continueSellingWhenOutOfStock === true;

    if (Array.isArray(p.variants) && p.variants.length > 0) {
      totalStock = p.variants.reduce((sum, v) => sum + (Number(v.stockQty) || 0), 0);
      canContinue = canContinue || p.variants.some(v => v.inventoryPolicy === 'continue' || v.continueSellingWhenOutOfStock === true);
    } else {
      totalStock = Number(p.stockQuantity ?? p.stockQty ?? 0);
    }

    const hasStock = canContinue || totalStock > 0;
    const targetStatus = hasStock ? ((p.compareAtPrice && p.compareAtPrice > p.price) ? 'Sale' : 'In Stock') : 'Sold Out';
    const targetInStock = hasStock;

    if (p.status !== targetStatus || p.inStock !== targetInStock) {
      console.log(`Reconciling "${p.name}": status "${p.status}" -> "${targetStatus}", inStock: ${p.inStock} -> ${targetInStock} (stock: ${totalStock}, continue: ${canContinue})`);
      await Product.updateOne(
        { _id: p._id },
        { 
          $set: { 
            status: targetStatus,
            inStock: targetInStock
          } 
        }
      );
      updatedCount++;
    }
  }

  console.log(`Reconciliation complete. Updated ${updatedCount} products.`);
  await mongoose.disconnect();
}

run().catch(console.error);
