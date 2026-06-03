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

    // ── Attachments ───────────────────────────────────────────────────
    // Mirrors the HRMS schema. Files are stored inline as base64 in
    // `dataBase64` so the mobile / ERM Web apps can render images
    // straight from the API response without a separate object store.
    // Each item: { name, mimeType, size, dataBase64, url, type }.
    // Without this field declared, Mongoose strict mode would silently
    // strip the array off the response — which is exactly why HRMS
    // uploads weren't reaching the ERM apps before today.
    attachments: {
      type: [
        {
          name:       { type: String, default: '' },
          mimeType:   { type: String, default: '' },
          size:       { type: Number, default: 0 },
          dataBase64: { type: String, default: '' },
          url:        { type: String, default: '' },
          type:       { type: String, default: '' },
        },
      ],
      default: [],
    },

    // ── Per-user read tracking (Jun 2026) ─────────────────────────────
    // Mirrors the notifications screen behaviour: tapping a card marks
    // the announcement read for THIS user only. Other employees still
    // see it as unread until they open it. We store user IDs as
    // ObjectIds so $addToSet works against the employees collection
    // without string-coercion churn.
    readBy: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
      index: true,
    },
  },
  { timestamps: true, strict: false }
);

announcementSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Announcement', announcementSchema);
