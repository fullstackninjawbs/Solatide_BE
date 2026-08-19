import { Request, Response } from 'express';
import ShippingPackage from '../../models/shippingPackage.model';

export const getPackages = async (req: Request, res: Response) => {
  try {
    const packages = await ShippingPackage.find({ active: true }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, packages });
  } catch (error: any) {
    console.error('Error fetching shipping packages:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch shipping packages.' });
  }
};

export const createPackage = async (req: Request, res: Response) => {
  try {
    const { name, type, dimensions, weight, isDefault } = req.body;

    const newPackage = new ShippingPackage({
      name,
      type,
      dimensions,
      weight,
      isDefault: isDefault || false
    });

    const savedPackage = await newPackage.save();
    res.status(201).json({ success: true, package: savedPackage });
  } catch (error: any) {
    console.error('Error creating shipping package:', error);
    res.status(500).json({ success: false, message: 'Failed to create shipping package.', error: error.message });
  }
};

export const updatePackage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, type, dimensions, weight, isDefault } = req.body;

    const packageToUpdate = await ShippingPackage.findOne({ _id: id, active: true });
    
    if (!packageToUpdate) {
      return res.status(404).json({ success: false, message: 'Shipping package not found.' });
    }

    packageToUpdate.name = name;
    packageToUpdate.type = type;
    packageToUpdate.dimensions = dimensions;
    packageToUpdate.weight = weight;
    
    // Check if isDefault is changing
    if (isDefault !== undefined) {
        packageToUpdate.isDefault = isDefault;
    }

    const updatedPackage = await packageToUpdate.save();

    res.status(200).json({ success: true, package: updatedPackage });
  } catch (error: any) {
    console.error('Error updating shipping package:', error);
    res.status(500).json({ success: false, message: 'Failed to update shipping package.', error: error.message });
  }
};

export const deletePackage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const packageToDelete = await ShippingPackage.findOne({ _id: id, active: true });
    if (!packageToDelete) {
      return res.status(404).json({ success: false, message: 'Shipping package not found.' });
    }

    if (packageToDelete.isDefault) {
      return res.status(400).json({ success: false, message: 'Cannot delete the default shipping package. Please set another package as default first.' });
    }

    packageToDelete.active = false;
    await packageToDelete.save();

    res.status(200).json({ success: true, message: 'Shipping package deleted successfully.' });
  } catch (error: any) {
    console.error('Error deleting shipping package:', error);
    res.status(500).json({ success: false, message: 'Failed to delete shipping package.', error: error.message });
  }
};

export const setDefaultPackage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const packageToUpdate = await ShippingPackage.findOne({ _id: id, active: true });
    if (!packageToUpdate) {
      return res.status(404).json({ success: false, message: 'Shipping package not found.' });
    }

    packageToUpdate.isDefault = true;
    const updatedPackage = await packageToUpdate.save();

    res.status(200).json({ success: true, package: updatedPackage });
  } catch (error: any) {
    console.error('Error setting default shipping package:', error);
    res.status(500).json({ success: false, message: 'Failed to set default shipping package.', error: error.message });
  }
};
