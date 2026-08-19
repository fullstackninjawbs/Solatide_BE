import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IShippingPackage extends Document {
  _id: Types.ObjectId;
  name: string;
  type: 'box' | 'envelope' | 'soft_package';
  dimensions?: {
    length: number;
    width: number;
    height: number;
    unit: 'cm';
  };
  weight: {
    value: number;
    unit: 'g' | 'kg';
  };
  isDefault: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const shippingPackageSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 100 },
    type: { type: String, enum: ['box', 'envelope', 'soft_package'], required: true },
    dimensions: {
      length: { type: Number },
      width: { type: Number },
      height: { type: Number },
      unit: { type: String, enum: ['cm'], default: 'cm' }
    },
    weight: {
      value: { type: Number, required: true },
      unit: { type: String, enum: ['g', 'kg'], required: true }
    },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// Pre-save hook to ensure only one package is default
shippingPackageSchema.pre('save', async function (next) {
  if (this.isDefault) {
    await this.$model('ShippingPackage').updateMany(
      { _id: { $ne: this._id } },
      { $set: { isDefault: false } }
    );
  }
  next();
});

export default mongoose.model<IShippingPackage>('ShippingPackage', shippingPackageSchema);
