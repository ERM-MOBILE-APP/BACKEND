/**
 * Firebase Cloud Messaging sender (backend side).
 *
 * Uses the Firebase Admin SDK to push to a user's registered devices. The
 * Admin private key lives ONLY here, loaded from an environment variable —
 * never shipped in the mobile app.
 *
 * Configure ONE of:
 *   FIREBASE_SERVICE_ACCOUNT_BASE64  — base64 of the service-account JSON (recommended for Render)
 *   FIREBASE_SERVICE_ACCOUNT_JSON    — the raw service-account JSON string
 *   GOOGLE_APPLICATION_CREDENTIALS   — path to the service-account JSON file
 *
 * If none is set, push is silently disabled (the in-app bell still works).
 */

let _admin = null;
let _initTried = false;

function getAdmin() {
  if (_initTried) return _admin;
  _initTried = true;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      let creds = null;
      if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        creds = JSON.parse(
          Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'),
        );
      } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      }

      if (creds) {
        // Render/Heroku often escape newlines in the private key.
        if (creds.private_key && creds.private_key.includes('\\n')) {
          creds.private_key = creds.private_key.replace(/\\n/g, '\n');
        }
        admin.initializeApp({ credential: admin.credential.cert(creds) });
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp(); // picks up the file path from the env var
      } else {
        console.warn('[fcm] No Firebase service account configured — push disabled.');
        _admin = null;
        return _admin;
      }
    }
    _admin = admin;
    console.log('[fcm] ✓ Firebase Admin initialised');
  } catch (e) {
    console.warn('[fcm] firebase-admin unavailable:', e.message);
    _admin = null;
  }
  return _admin;
}

/**
 * Send an FCM push to every device registered to `userId`.
 * Best-effort — logs and swallows all errors. Deletes tokens Firebase
 * reports as no longer registered.
 *
 * @param userId
 * @param opts.title
 * @param opts.body
 * @param opts.data  plain object; values are coerced to strings (FCM requirement)
 */
async function sendFcmToUser(userId, { title, body, data } = {}) {
  try {
    const admin = getAdmin();
    if (!admin) {
      // #522 diagnostic — make the "why nothing sent" reason visible instead of
      // returning silently. This fires when Firebase Admin didn't initialise
      // (missing / malformed FIREBASE_SERVICE_ACCOUNT_BASE64).
      console.warn(`[fcm] skip user=${userId}: Firebase Admin not initialised (check FIREBASE_SERVICE_ACCOUNT_BASE64)`);
      return;
    }

    const DeviceToken = require('../models/DeviceToken');
    const rows = await DeviceToken.find({ user: userId }).select('token').lean();
    const tokens = rows.map((r) => r.token).filter(Boolean);
    if (tokens.length === 0) {
      // #522 diagnostic — no device has registered a push token for this user
      // (app not on the new Firebase build, or notification permission denied).
      console.log(`[fcm] skip user=${userId}: no registered device tokens`);
      return;
    }

    // FCM data payload must be all-string.
    const dataStr = {};
    Object.entries(data || {}).forEach(([k, v]) => {
      dataStr[k] = v == null ? '' : String(v);
    });

    // Duplicate prevention: key both the collapseKey (dedupes messages still
    // queued at FCM) and the Android notification `tag` (a new push with the
    // same tag REPLACES the old one instead of stacking) on the unique
    // Notification id. So a retry of the SAME event never shows twice, while
    // different events keep their own separate notifications.
    const dedupeKey = dataStr.notificationId || undefined;

    const message = {
      tokens,
      notification: {
        title: String(title || 'Tesco ERM').slice(0, 120),
        body: String(body || '').slice(0, 240),
      },
      data: dataStr,
      android: {
        priority: 'high',
        collapseKey: dedupeKey,
        notification: {
          channelId: 'default',
          sound: 'default',
          tag: dedupeKey,
          // Ensures a tap delivers the data payload to the app for deep-linking.
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
    };

    const resp = await admin.messaging().sendEachForMulticast(message);

    // Prune tokens Firebase says are dead so we stop pushing to them.
    const dead = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          dead.push(tokens[i]);
        }
      }
    });
    if (dead.length) {
      try {
        await DeviceToken.deleteMany({ token: { $in: dead } });
        console.log('[fcm] pruned', dead.length, 'invalid token(s)');
      } catch { /* non-fatal */ }
    }

    console.log(`[fcm] sent user=${userId} ok=${resp.successCount}/${tokens.length}`);
  } catch (e) {
    console.warn('[fcm] send failed:', e.message);
  }
}

module.exports = { sendFcmToUser, getAdmin };
