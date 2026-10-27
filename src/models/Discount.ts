import mongoose, { Schema, Document } from 'mongoose';

/**
 * Discount — managed in the hub (Admin → Discounts) and applied by our own checkout
 * (services/discounts/discountService.ts, rules in domain/discountEngine.ts).
 *
 * The action is an order discount: `type` 'percent' | 'fixed' with `value`. `rules` are the
 * conditions (all / any, see `ruleMatch`). minPurchase / minQuantity are the older single
 * conditions, still honoured for discounts created before rules existed.
 */
export const DISCOUNT_RULE_TYPES = [
  'cart_min_quantity',
  'cart_total_min',
  'cart_total_max',
  'cart_contains_product',
  'excluded_products',
  'max_product_quantity',
] as const;
export type DiscountRuleType = (typeof DISCOUNT_RULE_TYPES)[number];

export interface IDiscountRule {
  type: DiscountRuleType;
  /** cart_min_quantity, max_product_quantity */
  quantity?: number;
  /** cart_total_min, cart_total_max (AUD) */
  amount?: number;
  /** cart_contains_product: any of these; excluded_products: never discounted;
   *  cart_min_quantity: these do not count toward the quantity */
  products?: mongoose.Types.ObjectId[];
}

export interface IDiscount extends Document {
  code: string;
  type: string;
  value: number;
  appliesTo: string;
  minPurchase: number;
  minQuantity: number;
  maxUses: number;
  usesSoFar: number;
  perCustomerLimit: number;
  activeFrom?: Date;
  activeTo?: Date;
  status: string;
  ruleMatch: 'all' | 'any';
  rules: IDiscountRule[];
  combinations: {
    product: boolean;
    order: boolean;
    shipping: boolean;
  };
  tags: string[];
  salesChannelAccess: boolean;
  /** Set when imported from Tagada (scripts/importTagadaDiscounts.ts) */
  tagadaPromotionId?: string;
  tagadaPromotionCodeId?: string;
}

const DiscountRuleSchema = new Schema(
  {
    type: { type: String, enum: DISCOUNT_RULE_TYPES, required: true },
    quantity: { type: Number, min: 0 },
    amount: { type: Number, min: 0 },
    products: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  },
  { _id: false }
);

const DiscountSchema = new Schema({
  code: { type: String, required: true, unique: true },
  type: { type: String, enum: ['percent', 'fixed'] },
  value: { type: Number, required: true },
  appliesTo: { type: String, enum: ['all', 'products', 'collections'], default: 'all' },
  minPurchase: { type: Number, default: 0 },
  minQuantity: { type: Number, default: 0 },
  maxUses: { type: Number, default: 0 },
  usesSoFar: { type: Number, default: 0 },
  perCustomerLimit: { type: Number, default: 1 },
  activeFrom: Date,
  activeTo: Date,
  status: { type: String, enum: ['active', 'expired', 'disabled'], default: 'active' },
  ruleMatch: { type: String, enum: ['all', 'any'], default: 'all' },
  rules: { type: [DiscountRuleSchema], default: [] },
  combinations: {
    product: { type: Boolean, default: false },
    order: { type: Boolean, default: false },
    shipping: { type: Boolean, default: false }
  },
  tags: [{ type: String }],
  salesChannelAccess: { type: Boolean, default: false },
  tagadaPromotionId: { type: String },
  tagadaPromotionCodeId: { type: String }
}, { timestamps: true });

export default mongoose.model<IDiscount>('Discount', DiscountSchema);
