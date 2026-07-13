import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import config from '../config';

// Configure Cloudinary
cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
});

/**
 * Uploads a buffer to Cloudinary
 * @param buffer - File buffer from multer
 * @param folder - Cloudinary folder name
 * @returns Promise that resolves with the Cloudinary upload result
 */
export const uploadImageBuffer = (buffer: Buffer, folder: string = 'reviews'): Promise<any> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

/**
 * Uploads a generic file buffer (like PDF) to Cloudinary
 * @param buffer - File buffer from multer
 * @param folder - Cloudinary folder name
 * @returns Promise that resolves with the Cloudinary upload result
 */
export const uploadFileBuffer = (buffer: Buffer, folder: string = 'documents'): Promise<any> => {
  return new Promise((resolve, reject) => {
    const options: any = {
      folder,
      resource_type: 'raw', // Use raw to prevent Cloudinary from blocking PDF delivery
      format: 'pdf', // Ensures the generated URL has the .pdf extension
    };

    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

/**
 * Deletes an image from Cloudinary given its secure_url
 * @param imageUrl - The Cloudinary secure_url
 * @returns Promise that resolves when deletion is complete
 */
export const deleteImageByUrl = async (imageUrl: string): Promise<void> => {
  try {
    // Extract public ID from the URL
    // e.g., https://res.cloudinary.com/demo/image/upload/v1234567890/folder/image_name.jpg
    const parts = imageUrl.split('/');
    const lastPart = parts.pop(); // image_name.jpg
    if (!lastPart) return;

    const publicIdWithExt = lastPart;
    const publicId = publicIdWithExt.split('.')[0]; // image_name

    // To get the full public_id including folder, we need to trace back from the upload directory
    const uploadIndex = parts.indexOf('upload');
    if (uploadIndex === -1) return;

    // Skipping the version string (e.g., v1234567890)
    const folderParts = parts.slice(uploadIndex + 2);
    const fullPublicId = folderParts.length > 0 ? `${folderParts.join('/')}/${publicId}` : publicId;

    await cloudinary.uploader.destroy(fullPublicId);
  } catch (error) {
    console.error('Error deleting image from Cloudinary:', error);
  }
};
