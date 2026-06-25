import mongoose from 'mongoose';

export interface IOrderItem {
  product: mongoose.Types.ObjectId;
  quantity: number;
  price: number; // Snapshot price at time of purchase
}

export interface IOrder extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  products: IOrderItem[];
  totalAmount: number;
  shippingAddress: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
  // Payment fields
  paymentMethod?: 'tagada' | 'payid' | 'bank_transfer';
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded';
  currency: string;
  // TagadaPay-specific tracking
  tagadaPaymentId?: string;
  tagadaPaymentStatus?: 'initiated' | 'authorized' | 'captured' | 'failed' | 'refunded';
  // Customer contact snapshot (for Tagada payload)
  customerEmail?: string;
  customerName?: string;
}

const orderSchema = new mongoose.Schema<IOrder>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    products: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Product',
          required: [true, 'Order item must have a product ID'],
        },
        quantity: {
          type: Number,
          required: [true, 'Order item must have a quantity'],
          min: [1, 'Quantity must be at least 1'],
        },
        price: {
          type: Number,
          required: [true, 'Order item must have a price snapshot'],
        },
      },
    ],
    totalAmount: {
      type: Number,
      required: [true, 'An order must have a total amount'],
      min: [0, 'Total amount must be positive'],
    },
    shippingAddress: {
      type: String,
      required: false,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
      default: 'pending',
    },
    // ── Payment ──────────────────────────────────────────────────────────────
    paymentMethod: {
      type: String,
      enum: ['tagada', 'payid', 'bank_transfer'],
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    currency: {
      type: String,
      default: 'AUD',
    },
    // ── TagadaPay ─────────────────────────────────────────────────────────────
    tagadaPaymentId: { type: String },
    tagadaPaymentStatus: {
      type: String,
      enum: ['initiated', 'authorized', 'captured', 'failed', 'refunded'],
    },
    // ── Customer snapshot for Tagada payload ─────────────────────────────────
    customerEmail: { type: String, trim: true },
    customerName: { type: String, trim: true },
  },
  {
    timestamps: true,
  }
);

// Populate user and products automatically on queries
orderSchema.pre(/^find/, function (this: any, next) {
  this.populate('user', 'name email').populate('products.product', 'name price category variants');
  next();
});

export const Order = mongoose.model<IOrder>('Order', orderSchema);
export default Order;
