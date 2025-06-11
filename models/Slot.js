// models/Slot.js
import mongoose from 'mongoose';

const slotSchema = new mongoose.Schema({
  time:       { type: Date,    required: true },
  user:       { type: String,  required: true },
  msg:        { type: String,  required: true },
  subscriber: { type: Boolean, required: true },
});

export default mongoose.model('Slot', slotSchema);