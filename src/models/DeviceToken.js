const mongoose = require('mongoose');

/**
 * DeviceToken — one row per (device) FCM registration token.
 *
 * A user may be logged in on several devices, so one User can own many
 * DeviceToken rows. The `token` is globally unique: if the same device
 * token is re-registered by a different user (shared phone), the row is
 * reassigned to the new user (upsert on token) so a device only ever
 * belongs to the currently-logged-in user.
 *
 * Invalid tokens (Firebase reports `registration-token-not-registered`)
 * are deleted by utils/fcm.js when a send fails, so we never keep pushing
 * to uninstalled apps.
 */
const deviceTokenSchema = new mongoose.Schema(
  {
    user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role:     { type: String, default: 'employee' },
    token:    { type: String, required: true, unique: true, index: true },
    platform: { type: String, default: 'android' },
    deviceId: { type: String, default: '' },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }, // createdAt / updatedAt
);

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
