import mongoose, { Document, Schema } from 'mongoose';

export type RedirectSource = 'auto' | 'manual' | 'import';
export type RedirectEntityKind = 'product' | 'collection' | 'page';

export interface IRedirect extends Document {
  /** Normalised old path, e.g. "/products/selank-semax-20mg" */
  fromPath: string;
  /** Internal target path (may carry its own query), e.g. "/products/selank-10mg" */
  toPath: string;
  statusCode: 301 | 302;
  /** auto = created by a URL change; manual = added in admin; import = migrated (nginx / app / slugHistory) */
  source: RedirectSource;
  /** The item an auto redirect points at, so later renames keep it to one hop */
  entity?: { kind: RedirectEntityKind; id: mongoose.Types.ObjectId };
  /** Redirects are disabled, never deleted */
  active: boolean;
  hits: number;
  lastHitAt?: Date | null;
  note?: string;
  createdBy?: mongoose.Types.ObjectId | null;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const redirectSchema = new Schema<IRedirect>(
  {
    fromPath: { type: String, required: true, trim: true, maxlength: 500 },
    toPath: { type: String, required: true, trim: true, maxlength: 500 },
    statusCode: { type: Number, enum: [301, 302], default: 301 },
    source: { type: String, enum: ['auto', 'manual', 'import'], required: true },
    entity: {
      kind: { type: String, enum: ['product', 'collection', 'page'] },
      id: { type: Schema.Types.ObjectId },
    },
    active: { type: Boolean, default: true },
    hits: { type: Number, default: 0 },
    lastHitAt: { type: Date, default: null },
    note: { type: String, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// One ACTIVE redirect per old path (disabled ones are kept as history)
redirectSchema.index({ fromPath: 1 }, { unique: true, partialFilterExpression: { active: true }, name: 'fromPath_active_unique' });
redirectSchema.index({ 'entity.kind': 1, 'entity.id': 1 });
redirectSchema.index({ toPath: 1 });

const Redirect = mongoose.model<IRedirect>('Redirect', redirectSchema);
export default Redirect;
