const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    category: {
      type: String,
      enum: ['holiday', 'policy', 'event', 'general'],
      default: 'general',
    },
    postedBy: { type: String, default: 'HR' },
    audience: {
      type: String,
      enum: ['all', 'department', 'team'],
      default: 'all',
    },
    isActive: { type: Boolean, default: true },
    // When this row came from an HRMS-posted announcement, externalId stores
    // the HRMS document _id so subsequent updates / deletes from HRMS can
    // find and refresh the right mobile row instead of duplicating.
    externalId: { type: String, default: null, index: true, sparse: true },
  },
  { timestamps: true }
);

announcementSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Announcement', announcementSchema);
