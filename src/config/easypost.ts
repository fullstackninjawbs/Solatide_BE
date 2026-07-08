import EasyPostClient from '@easypost/api';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.EASYPOST_API_KEY;

if (!apiKey) {
  console.warn('WARNING: EASYPOST_API_KEY is not configured in environment variables.');
}

// Initialize the EasyPost client once.
// We pass a fallback string to prevent the SDK from throwing an error on startup 
// if the key is missing. The controller will handle the missing key error gracefully.
const client = new EasyPostClient(apiKey || 'missing_key');

export default client;
