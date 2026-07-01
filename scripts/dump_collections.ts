import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import Collection from '../src/models/collection.model';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not found');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const collections = await Collection.find({});
  console.log('Collections in DB:');
  console.log(JSON.stringify(collections, null, 2));
  await mongoose.disconnect();
}

main().catch(console.error);
