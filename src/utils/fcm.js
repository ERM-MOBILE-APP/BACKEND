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

    const safeTitle = String(title || 'Tesco ERM').slice(0, 120);
    const safeBody  = String(body || '').slice(0, 240);

    const message = {
      tokens,
      notification: {
        title: safeTitle,
        body: safeBody,
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
      // #545 — Web push. The SAME send now reaches browser (ERM Web) tokens
      // too: FCM uses this block for web registration tokens, so a desktop /
      // laptop running the ERM Web app gets a real OS/system notification (not
      // just the in-app bell). fcmOptions.link opens the deep link on click.
      webpush: {
        headers: {
          Urgency: 'high',
          ...(dedupeKey ? { Topic: String(dedupeKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
        },
        notification: {
          title: safeTitle,
          body:  safeBody,
          tag:   dedupeKey || undefined,
          icon:  '/icons/notification-icon.png',
          badge: '/icons/notification-badge.png',
          renotify: !!dedupeKey,
        },
        // fcmOptions.link must be an ABSOLUTE https URL. Our deep links are
        // usually app-relative (e.g. "/manager"), so we omit it here and let
        // the service worker's notificationclick handler open data.link.
        ...(dataStr.link && /^https?:\/\//i.test(dataStr.link)
          ? { fcmOptions: { link: dataStr.link } }
          : {}),
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

/**
 * #547 — Broadcast an FCM push to EVERY registered device. Used for company-
 * wide announcements posted from HRMS or ERM Web (which have no Firebase
 * service account, so they call this via the admin endpoint). Batches into
 * groups of 500 (FCM multicast limit) and prunes dead tokens.
 */
async function sendFcmBroadcast({ title, body, data } = {}) {
  try {
    const admin = getAdmin();
    if (!admin) {
      console.warn('[fcm] broadcast skip: Firebase Admin not initialised (check FIREBASE_SERVICE_ACCOUNT_BASE64)');
      return { ok: 0, total: 0 };
    }
    const DeviceToken = require('../models/DeviceToken');
    const rows = await DeviceToken.find({}).select('token').lean();
    const all = [...new Set(rows.map((r) => r.token).filter(Boolean))];
    if (all.length === 0) {
      console.log('[fcm] broadcast skip: no registered device tokens');
      return { ok: 0, total: 0 };
    }

    const dataStr = {};
    Object.entries(data || {}).forEach(([k, v]) => { dataStr[k] = v == null ? '' : String(v); });
    const safeTitle = String(title || 'Tesco ERM').slice(0, 120);
    const safeBody  = String(body || '').slice(0, 240);

    const base = {
      notification: { title: safeTitle, body: safeBody },
      data: dataStr,
      android: {
        priority: 'high',
        notification: {
          channelId: 'default',
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { title: safeTitle, body: safeBody, icon: '/icons/notification-icon.png' },
        ...(dataStr.link && /^https?:\/\//i.test(dataStr.link) ? { fcmOptions: { link: dataStr.link } } : {}),
      },
    };

    let ok = 0;
    const dead = [];
    for (let i = 0; i < all.length; i += 500) {
      const chunk = all.slice(i, i + 500);
      const resp = await admin.messaging().sendEachForMulticast({ ...base, tokens: chunk });
      ok += resp.successCount;
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument'
          ) dead.push(chunk[idx]);
        }
      });
    }
    if (dead.length) {
      try { await DeviceToken.deleteMany({ token: { $in: dead } }); } catch { /* non-fatal */ }
    }
    console.log(`[fcm] broadcast sent ok=${ok}/${all.length}`);
    return { ok, total: all.length };
  } catch (e) {
    console.warn('[fcm] broadcast failed:', e.message);
    return { ok: 0, total: 0 };
  }
}

module.exports = { sendFcmToUser, sendFcmBroadcast, getAdmin };
