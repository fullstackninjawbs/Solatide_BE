const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const testUpdate = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { dbName: 'test' });
    const Product = require('./models/product.model').default;
    
    const product = await Product.findOne({ id: 19 });
    if (!product) {
      console.log('Product not found');
      return;
    }
    
    console.log('Before update variant 0 stockQty:', product.variants[0].stockQty);
    
    const productData = {
      stockQuantity: 15,
      variants: [
        {
          _id: product.variants[0]._id,
          title: "Default Title",
          sku: "SOL-TB5-010",
          price: 89.95,
          stockQty: 15,
          inventoryPolicy: "deny",
          requiresShipping: true
        }
      ]
    };
    
    const updatedProduct = await Product.findByIdAndUpdate(product._id, productData, {
      new: true,
      runValidators: true,
    });
    
    console.log('After update variant 0 stockQty:', updatedProduct.variants[0].stockQty);
    console.log('After update root stockQuantity:', updatedProduct.stockQuantity);
    
  } catch (err) {
    console.error(err);
  } finally {
    mongoose.connection.close();
  }
};

testUpdate();
