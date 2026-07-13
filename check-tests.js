const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const Batch = require('./dist/models/batch.model').default;
  const batches = await Batch.find({ 'tests.purityHplc.result': { $ne: '' } });
  console.log('Batches with purity results:', batches.length);
  if(batches.length > 0) {
    console.log(batches[0].batchId, batches[0].tests);
  }
  process.exit(0);
}).catch(console.error);
