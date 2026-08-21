import dotenv from 'dotenv';
import path from 'path';
import { getTagadaClient } from './services/tagadaClient';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function run() {
  const client = await getTagadaClient();
  try {
    console.log('Client keys:', Object.keys(client));
    if (client.products) {
      console.log('Products keys:', Object.keys(client.products));
    }
  } catch (err: any) {
    console.log('API failed:', err.message);
  }
  process.exit(0);
}

run();
