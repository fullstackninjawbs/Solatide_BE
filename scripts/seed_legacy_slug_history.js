const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  
  const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }));
  
  const aliases = [
    { current: 'selank-10mg', old: 'selank-semax-20mg' },
    { current: 'mots-c-10mg', old: 'mots-c-10mg-lyophilised-peptide' },
    { current: 'ss-31-elamipretide-10mg', old: 'ss-31-elamipretide-10mg-lyophilised-peptide' },
    { current: 'kpv-10mg', old: 'kpv-10mg-lyophilised-peptide' }
  ];

  for (const a of aliases) {
    const res = await Product.updateOne(
      { slug: a.current },
      { $addToSet: { slugHistory: a.old } }
    );
    console.log(`Updated ${a.current} with old slug ${a.old}:`, res.modifiedCount);
  }

  await mongoose.disconnect();
  console.log('Done!');
}

run().catch(console.error);
