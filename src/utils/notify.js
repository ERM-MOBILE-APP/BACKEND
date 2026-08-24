/**
 * Tiny wrapper around the Notification model + device push delivery.
 *
 *   await notify(user._id, {
 *     title: 'Leave Approved',
 *     body:  'Your leave for 12-15 Mar was approved.',
 *     type:  'leave',
 *     link:  '/(tabs)/leave',
 *   });
 *
 * Every notify() does TWO things, both best-effort:
 *   1. Writes a Notification row (drives the in-app bell / list).
 *   2. Sends an Expo push to the user's registered devices so they get a
 *      system notification even when the app is closed / backgrounded.
 *
 * Neither step ever throws into the caller — a status-update API must never
 * fail just because a notification or push couldn't be delivered.
 */

const Notification = require('../models/Notification');

const VALID_TYPES = ['leave', 'attendance', 'allowance', 'payslip', 'announcement', 'general'];

async function notify(userId, opts = {}) {
  if (!userId || !opts || !opts.title) return null;
  let doc = null;
  try {
    const payload = {
      user:  userId,
      title: String(opts.title).slice(0, 200),
      body:  String(opts.body || '').slice(0, 800),
      type:  VALID_TYPES.includes(opts.type) ? opts.type : 'general',
      link:  opts.link || '',
    };
    doc = await Notification.create(payload);
    console.log(
      `[notify] ✓ → user=${userId} type=${payload.type} title="${payload.title}"`
    );
  } catch (err) {
    console.error('[notify] FAILED:', err.message);
    return null;
  }

  // Fire-and-forget FCM device push. Never blocks or fails the notify().
  try {
    const { sendFcmToUser } = require('./fcm');
    sendFcmToUser(userId, {
      title: opts.title,
      body: opts.body,
      data: {
        type: opts.type || 'general',
        link: opts.link || '',
        notificationId: doc && doc._id ? String(doc._id) : '',
      },
    }).catch(() => {});
  } catch (e) {
    console.warn('[notify] fcm dispatch failed:', e.message);
  }

  return doc;
}

module.exports = { notify };
