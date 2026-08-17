import { buildTagadaClient } from './src/services/tagadaClient';
import config from './src/config';

async function test() {
  const client = await buildTagadaClient();
  try {
    const res = await client.products.list({ storeId: config.tagadaStoreId, page: 1, limit: 1 });
    const product = res.data[0];
    console.log(JSON.stringify(product, null, 2));
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}

test().catch(console.error);
