import mongoose from 'mongoose';
import dotenv from 'dotenv';
import config from '../config';
import Product from '../models/product.model';
import User from '../models/user.model';

dotenv.config();

const mockProducts = [
  {
    name: 'Bacteriostatic Water 10mL (Metabolic Grade)',
    description: 'High-purity sterile water container containing 0.9% benzyl alcohol preservative. Formulated for stability in Metabolic Pathway Research.',
    price: 1400.00,
    rating: 5.0,
    inStock: true,
    category: 'Metabolic Pathway Research',
    status: 'In Stock',
  },
  {
    name: 'Bacteriostatic Water 10mL (Cellular Grade)',
    description: 'Specialized reconstitution solution optimized for delicate tissue culture and cellular morphology investigations.',
    price: 1400.00,
    rating: 5.0,
    inStock: false,
    category: 'Tissue & Cellular Research',
    status: 'Sold Out',
  },
  {
    name: 'Bacteriostatic Water 10mL (Dermal Grade)',
    description: 'Preserved research solvent designed for solubility studies in dermal cell layers and pigmentation peptide matrices.',
    price: 1400.00,
    rating: 5.0,
    inStock: true,
    category: 'Dermal & Pigmentation Research',
    status: 'Sale',
  },
  {
    name: 'Reconstituted Peptide Solvent 5mL',
    description: 'Buffered preservation solution engineered to extend the shelf-life of reconstituted lab proteins and peptides.',
    price: 950.00,
    rating: 4.8,
    inStock: true,
    category: 'Metabolic Pathway Research',
    status: 'In Stock',
  },
  {
    name: 'Sterile Physiological Saline 10mL',
    description: '0.9% Sodium Chloride laboratory solvent, autoclaved and certified endotoxin-free for tissue analysis.',
    price: 1200.00,
    rating: 4.9,
    inStock: true,
    category: 'Tissue & Cellular Research',
    status: 'In Stock',
  },
  {
    name: 'Research Grade Pigment Elixir 10mg',
    description: 'High-purity laboratory research peptide standard designed for testing cellular melanogenesis in culture.',
    price: 3500.00,
    rating: 5.0,
    inStock: true,
    category: 'Dermal & Pigmentation Research',
    status: 'In Stock',
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
