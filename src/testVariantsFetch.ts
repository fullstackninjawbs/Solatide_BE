import dotenv from 'dotenv';
import path from 'path';
import { getTagadaClient } from './services/tagadaClient';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function run() {
  const client = await getTagadaClient();
  try {
    const response = await client.variants.list({ productId: 'product_99e256743b81' });
    console.log('Variants API response:', JSON.stringify(response, null, 2));
  } catch (err: any) {
    console.log('Variants API failed:', err.message);
  }
  process.exit(0);
}

run();
