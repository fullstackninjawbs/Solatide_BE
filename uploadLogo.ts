import { uploadImageBuffer } from './src/utils/cloudinary';
import path from 'path';
import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

async function upload() {
  const filePath = path.resolve('..', 'Client', 'src', 'assets', 'icons', 'logo.png');
  const buffer = fs.readFileSync(filePath);
  try {
    const result = await uploadImageBuffer(buffer, 'assets');
    console.log('UPLOADED URL:', result.secure_url);
  } catch (err) {
    console.error('Error uploading:', err);
  }
}
upload();
