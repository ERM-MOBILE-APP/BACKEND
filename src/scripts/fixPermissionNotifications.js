/**
 * One-time migration — relabel OLD permission notifications.
 *
 * Before the notify fix, a Permission request notified the manager with the
 * title "New leave request from <name>" (it shares the Leave collection and was
 * sent with type:'leave'). New notifications are now titled correctly, but rows
 * already in the database still read "leave request". This script rewrites the
 * TITLE of those existing rows to "New permission request from <name>".
 *
 * It only touches notifications whose BODY says "submitted: Permission", so real
 * leave notifications are never changed. The body itself already reads
 * "submitted: Permission …" and is left as-is.
 *
 * USAGE (from the backend folder, with the same MONGO_URI the app uses):
 *   node src/scripts/fixPermissionNotifications.js            # apply changes
 *   node src/scripts/fixPermissionNotifications.js --dry-run  # preview only
 *
 * Safe to run more than once — already-fixed rows no longer match the filter.
 */
try { require('dotenv').config(); } catch { /* env injected directly (e.g. Render) */ }
const mongoose = require('mongoose');
const Notification = require('../models/Notification');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Run this where the backend env is available.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`[fix-perm-notifs] connected${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

  // Permission notifications that were mislabelled as "leave request".
  const filter = {
    type: 'leave',
    title: /^New leave request from/i,
    body:  /submitted:\s*Permission/i,
  };

  const matches = await Notification.find(filter).select('_id title').lean();
  console.log(`[fix-perm-notifs] found ${matches.length} permission notification(s) titled as "leave request".`);

  if (matches.length === 0) {
    await mongoose.disconnect();
    console.log('[fix-perm-notifs] nothing to do.');
    return;
  }

  // Show a small sample so you can eyeball it before/after.
  matches.slice(0, 5).forEach((m) => {
    const after = m.title.replace(/leave request/i, 'permission request');
    console.log(`   • "${m.title}"  →  "${after}"`);
  });

  if (DRY_RUN) {
    await mongoose.disconnect();
    console.log('[fix-perm-notifs] dry run complete — no changes written.');
    return;
  }

  // Rewrite the title in place, one by one (keeps the exact <name> suffix).
  let updated = 0;
  for (const m of matches) {
    const newTitle = m.title.replace(/leave request/i, 'permission request');
    if (newTitle !== m.title) {
      await Notification.updateOne({ _id: m._id }, { $set: { title: newTitle } });
      updated++;
    }
  }

  console.log(`[fix-perm-notifs] updated ${updated} notification(s).`);
  await mongoose.disconnect();
  console.log('[fix-perm-notifs] done.');
})().catch((e) => {
  console.error('[fix-perm-notifs] failed:', e);
  process.exit(1);
});
