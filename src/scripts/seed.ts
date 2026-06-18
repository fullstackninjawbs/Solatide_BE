import mongoose from 'mongoose';
import dotenv from 'dotenv';
import config from '../config';
import Product from '../models/product.model';
import User from '../models/user.model';

dotenv.config();

const mockProducts = [
  {
    id: 1,
    name: 'Bacteriostatic Water 10mL',
    description: 'Bacteriostatic Water for Injection is sterile, non-pyrogenic water containing 0.9% benzyl alcohol added as a bacteriostatic preservative. It is designed for reconstituting research compounds.',
    price: 1400.00,
    rating: 5.0,
    inStock: true,
    category: 'Metabolic Pathway Research',
    status: 'In Stock',
    tag: 'Metabolic Pathway Research',
    reviewsCount: 24,
  },
  {
    id: 2,
    name: 'Retatrutide 10mg – Lyophilised Peptide',
    description: 'Retatrutide is a triple agonist research peptide targeting GLP-1, GIP, and glucagon receptors for laboratory investigation of integrated metabolic pathways. ≥99% purity based on available third-party documentation. Strictly for in-vitro research use only.',
    price: 8900.00,
    rating: 5.0,
    inStock: false,
    category: 'Tissue & Cellular Research',
    status: 'Sold Out',
    tag: 'Dual GLP-1/GIP Receptor Agonist',
    reviewsCount: 44,
  },
  {
    id: 3,
    name: 'Tirzepatide 10mg',
    description: 'Tirzepatide is a dual GIP and GLP-1 receptor agonist research peptide. Synthesized for experimental studies targeting metabolic disorders, insulin pathways, and cellular energy research.',
    price: 7200.00,
    rating: 5.0,
    inStock: true,
    category: 'Dermal & Pigmentation Research',
    status: 'Sale',
    tag: 'Dual GIP/GLP-1 Receptor Agonist',
    reviewsCount: 18,
  },
  {
    id: 4,
    name: 'Semaglutide 5mg',
    description: 'Semaglutide is a highly stable GLP-1 receptor agonist studied in metabolic pathways, appetite regulation, and cellular insulin-response models.',
    price: 5400.00,
    rating: 5.0,
    inStock: true,
    category: 'Metabolic Pathway Research',
    status: 'In Stock',
    tag: 'GLP-1 Receptor Agonist',
    reviewsCount: 32,
  },
  {
    id: 5,
    name: 'BPC-157 10mg',
    description: 'BPC-157 is a pentadecapeptide composed of 15 amino acids, studied extensively for recovery, cellular repair, and soft-tissue response models.',
    price: 4800.00,
    rating: 5.0,
    inStock: true,
    category: 'Tissue & Cellular Research',
    status: 'In Stock',
    tag: 'Tissue & Cellular Research',
    reviewsCount: 56,
  },
  {
    id: 6,
    name: 'Melanotan II 10mg',
    description: 'Melanotan II is a synthetic analog of the peptide hormone alpha-melanocyte stimulating hormone, studied in dermal pigmentation research.',
    price: 4500.00,
    rating: 5.0,
    inStock: true,
    category: 'Dermal & Pigmentation Research',
    status: 'In Stock',
    tag: 'Dermal & Pigmentation Research',
    reviewsCount: 29,
  },
];

const seedDB = async (): Promise<void> => {
  try {
    console.log('[Seeder] Connecting to database...');
    await mongoose.connect(config.mongoUri);
    console.log('[Seeder] Connected successfully.');

    // 1) Clean products catalog
    console.log('[Seeder] Cleaning existing products...');
    await Product.deleteMany({});

    // 2) Seed products
    console.log('[Seeder] Inserting new products...');
    await Product.insertMany(mockProducts);
    console.log(`[Seeder] Seeded ${mockProducts.length} products successfully.`);

    // 3) Create an admin user if it doesn't exist for test purposes
    console.log('[Seeder] Checking for default admin user...');
    const adminEmail = 'admin@solatide.com';
    const adminExists = await User.findOne({ email: adminEmail });
    if (!adminExists) {
      console.log('[Seeder] Admin user not found. Creating default admin...');
      await User.create({
        name: 'Admin Developer',
        email: adminEmail,
        password: 'adminpassword123',
        role: 'admin',
      });
      console.log(`[Seeder] Default Admin created successfully. Credentials: Email: ${adminEmail} | Password: adminpassword123`);
    } else {
      console.log('[Seeder] Admin user already exists.');
    }

    console.log('[Seeder] Seeding process complete. Exiting.');
    process.exit(0);
  } catch (error) {
    console.error(`[Seeder Error] ${(error as Error).message}`);
    process.exit(1);
  }
};

seedDB();
