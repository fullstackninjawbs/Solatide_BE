import mongoose, { Schema, Document } from 'mongoose';

/**
 * OrderRequest — temporary checkout (no payment processor): the customer submits their details and
 * cart; the store emails the request to the admin, who creates the order in Admin and arranges
 * payment. Kept in the database so no request is lost if an email fails.
 */
export interface IOrderRequest extends Document {
  requestNumber: string;
  clientRequestId: string;
  status: 'new' | 'handled' | 'cancelled';
  customer: { email: string; firstName: string; lastName: string; phone: string };
  shippingAddress: { company?: string; street1: string; street2?: string; city: string; state?: string; zip: string; country: string };
  items: Array<{ product: any; variant?: any | null; title: string; variantTitle?: string; sku?: string; quantity: number; unitPrice: number; subtotal: number }>;
  subtotal: number;
  /** Discount code applied at checkout (checked against the hub rules when submitted) */
  discountCode?: string;
  discountAmount?: number;
  /** null = to be confirmed with the payment instructions */
  shippingAmount?: number | null;
  total?: number;
  currency: string;
  notes?: string;
  emailedAdminAt?: Date | null;
  emailedCustomerAt?: Date | null;
  /** Set when the admin created the order from this request (Admin → Create order) */
  orderId?: any;
  handledAt?: Date | null;
  visitor?: { sessionId?: string; country?: string };
}

const OrderRequestSchema = new Schema<IOrderRequest>(
  {
    requestNumber: { type: String, required: true, unique: true },
    clientRequestId: { type: String, required: true, unique: true, maxlength: 100 },
    status: { type: String, enum: ['new', 'handled', 'cancelled'], default: 'new' },
    customer: {
      email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
      firstName: { type: String, required: true, trim: true, maxlength: 60 },
      lastName: { type: String, required: true, trim: true, maxlength: 60 },
      phone: { type: String, required: true, trim: true, maxlength: 30 },
    },
    shippingAddress: {
      company: { type: String, trim: true, maxlength: 120 },
      street1: { type: String, required: true, trim: true, maxlength: 120 },
      street2: { type: String, trim: true, maxlength: 120 },
      city: { type: String, required: true, trim: true, maxlength: 80 },
      state: { type: String, trim: true, maxlength: 80 },
      zip: { type: String, required: true, trim: true, maxlength: 20 },
      country: { type: String, required: true, trim: true, maxlength: 2 },
    },
    items: [{
      _id: false,
      product: { type: Schema.Types.ObjectId, ref: 'Product' },
      variant: { type: Schema.Types.ObjectId, default: null },
      title: String, variantTitle: String, sku: String,
      quantity: Number, unitPrice: Number, subtotal: Number,
    }],
    subtotal: { type: Number, required: true, min: 0 },
    discountCode: { type: String, trim: true, maxlength: 64 },
    discountAmount: { type: Number, min: 0, default: 0 },
    shippingAmount: { type: Number, min: 0, default: null },
    total: { type: Number, min: 0 },
    currency: { type: String, default: 'AUD' },
    notes: { type: String, trim: true, maxlength: 1000 },
    emailedAdminAt: { type: Date, default: null },
    emailedCustomerAt: { type: Date, default: null },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    handledAt: { type: Date, default: null },
    visitor: { sessionId: { type: String, maxlength: 128 }, country: { type: String, maxlength: 100 } },
  },
  { timestamps: true }
);

OrderRequestSchema.index({ createdAt: -1 });

export default mongoose.model<IOrderRequest>('OrderRequest', OrderRequestSchema);
