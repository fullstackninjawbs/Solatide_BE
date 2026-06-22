import mongoose, { Schema, Document } from 'mongoose';

const CompoundSchema = new Schema({
  name: String,
  sequence: String,
  molecularFormula: String,
  molecularWeight: String,
  halfLife: String,
  description: String
}, { timestamps: true });

export default mongoose.model('Compound', CompoundSchema);