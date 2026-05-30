const mongoose = require('mongoose');

/**
 * Asset — physical / IT items HRMS issues to employees (laptop,
 * monitor, ID card, etc.). Same shared `assets` collection HRMS writes
 * to; we just expose a read-only window for mobile.
 */
const assetSchema = new mongoose.Schema({
  assetName:    { type: String, default: '' },
  assetId:      { type: String, default: '' },
  type:         { type: String, default: '' },     // Laptop / Monitor / ID Card / …
  serialNo:     { type: String, default: '' },
  employeeId:   { type: String, default: '', uppercase: true, trim: true, index: true },
  employeeName: { type: String, default: '' },
  issuedDate:   { type: Date,   default: null },
  condition:    { type: String, default: 'Good' },
  status:       { type: String, default: 'Assigned' },
}, {
  collection: 'assets',
  timestamps: true,
  strict: false,
});

module.exports = mongoose.model('Asset', assetSchema);
