/**
 * Tiny wrapper around the Notification model.
 *
 *   await notify(user._id, {
 *     title: 'Leave Approved',
 *     body:  'Your leave for 12-15 Mar was approved.',
 *     type:  'leave',
 *     link:  '/(tabs)/leave',
 *   });
 *
 * Notifications fail silently — they're a UX nicety and should never
 * abort the parent request (e.g. status-update API) if the DB write fails.
 */

const Notification = require('../models/Notification');

const VALID_TYPES = ['leave', 'attendance', 'allowance', 'payslip', 'announcement', 'general'];

async function notify(userId, opts = {}) {
  if (!userId || !opts || !opts.title) return null;
  try {
    const payload = {
      user:  userId,
      title: String(opts.title).slice(0, 200),
      body:  String(opts.body || '').slice(0, 800),
      type:  VALID_TYPES.includes(opts.type) ? opts.type : 'general',
      link:  opts.link || '',
    };
    const doc = await Notification.create(payload);
    console.log(
      `[notify] ✓ → user=${userId} type=${payload.type} title="${payload.title}"`
    );
    return doc;
  } catch (err) {
    console.error('[notify] FAILED:', err.message);
    return null;
  }
}

module.exports = { notify };
