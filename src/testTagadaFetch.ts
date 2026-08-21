import dotenv from 'dotenv';
import path from 'path';
import { fetchTagadaProducts } from './services/tagadaProductSync.service';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function run() {
  const products = await fetchTagadaProducts();
  const selank = products.find(p => p.name.includes('Selank'));
  console.log(JSON.stringify(selank, null, 2));
  process.exit(0);
}

run();
