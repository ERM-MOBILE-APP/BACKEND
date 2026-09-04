const Notification = require('../models/Notification');
const User = require('../models/User');
const DeviceToken = require('../models/DeviceToken');

// POST /api/notification/admin/push   (header: x-admin-secret)
// Server-to-server FCM fan-out. The ERM Web backend has NO Firebase service
// account, so when a web-originated event needs a system notification it calls
// this endpoint; we look up the user's device tokens (browser + phone, shared
// DeviceToken collection) and push via firebase-admin. Body:
//   { userId | employeeId, title, body, link?, type?, notificationId? }
exports.adminPush = async (req, res) => {
  try {
    const expected = (process.env.MOBILE_ADMIN_SECRET || process.env.ADMIN_SECRET || '').trim();
    const got      = String(req.headers['x-admin-secret'] || '').trim();
    if (!expected || got !== expected) {
      return res.status(401).json({ success: false, message: 'Missing/invalid x-admin-secret.' });
    }
    let { userId, employeeId, title, body, link, type, notificationId } = req.body || {};
    if (!title) return res.status(400).json({ success: false, message: 'title is required.' });

    // Resolve the target user — accept a Mongo _id or an employeeId string.
    if (!userId && employeeId) {
      const u = await User.findOne({ employeeId: String(employeeId) }).select('_id').lean();
      userId = u && u._id;
    }
    if (!userId) return res.status(404).json({ success: false, message: 'User not found.' });

    const { sendFcmToUser } = require('../utils/fcm');
    await sendFcmToUser(userId, {
      title,
      body,
      data: {
        type: type || 'general',
        link: link || '',
        notificationId: notificationId || '',
      },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[notification.adminPush]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/notification/admin/broadcast   (header: x-admin-secret)
// Company-wide FCM push — used when HRMS or ERM Web posts a broadcast/company
// announcement. Those backends have no Firebase service account, so they call
// this to push a system notification to EVERY registered device.
//   Body: { title, body, link?, type? }
exports.adminBroadcast = async (req, res) => {
  try {
    const expected = (process.env.MOBILE_ADMIN_SECRET || process.env.ADMIN_SECRET || '').trim();
    const got      = String(req.headers['x-admin-secret'] || '').trim();
    if (!expected || got !== expected) {
      return res.status(401).json({ success: false, message: 'Missing/invalid x-admin-secret.' });
    }
    const { title, body, link, type } = req.body || {};
    if (!title) return res.status(400).json({ success: false, message: 'title is required.' });

    const { sendFcmBroadcast } = require('../utils/fcm');
    const result = await sendFcmBroadcast({
      title,
      body,
      data: { type: type || 'announcement', link: link || '' },
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[notification.adminBroadcast]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/notification/register-device   { token, platform?, deviceId? }
// Store the device's FCM registration token against the LOGGED-IN user so the
// backend (via firebase-admin) can push to it. Upsert on `token` so:
//   • re-registering the same token just refreshes lastUsedAt (no duplicates),
//   • a shared device is reassigned to whoever is currently logged in.
exports.registerDevice = async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ message: 'token is required.' });
    const platform = String(req.body?.platform || 'android').trim().toLowerCase();
    const deviceId = String(req.body?.deviceId || '').trim();

    let role = 'employee';
    try {
      const u = await User.findById(req.user.id).select('role').lean();
      role = (u && u.role) || 'employee';
    } catch { /* default role */ }

    await DeviceToken.findOneAndUpdate(
      { token },
      {
        $set: {
          user: req.user.id,
          role,
          platform,
          deviceId,
          lastUsedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[notification.registerDevice]', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/notification/unregister-device   { token }
// Detach a device from the current user (call on logout).
exports.unregisterDevice = async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ message: 'token is required.' });
    await DeviceToken.deleteOne({ token, user: req.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('[notification.unregisterDevice]', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/notification?limit=&onlyUnread=
exports.list = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const onlyUnread = req.query.onlyUnread === 'true';

    const q = { user: req.user.id };
    if (onlyUnread) q.isRead = false;

    const items = await Notification.find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const unreadCount = await Notification.countDocuments({
      user: req.user.id,
      isRead: false,
    });
    res.json({ items, unreadCount });
  } catch (err) {
    console.error('notification.list error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/notification/unread-count
exports.unreadCount = async (req, res) => {
  try {
    const n = await Notification.countDocuments({
      user: req.user.id,
      isRead: false,
    });
    res.json({ unreadCount: n });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/notification/:id
exports.getById = async (req, res) => {
  try {
    const n = await Notification.findOne({
      _id: req.params.id,
      user: req.user.id,
    });
    if (!n) return res.status(404).json({ message: 'Not found' });
    res.json(n);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/notification   (admin / system)
exports.create = async (req, res) => {
  try {
    const { user, title, body, type, link } = req.body || {};
    if (!user || !title) {
      return res.status(400).json({ message: 'user and title are required' });
    }
    const n = await Notification.create({ user, title, body, type, link });
    res.status(201).json(n);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// PATCH /api/notification/:id/read
exports.markAsRead = async (req, res) => {
  try {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { isRead: true },
      { new: true }
    );
    if (!n) return res.status(404).json({ message: 'Not found' });
    res.json(n);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// PATCH /api/notification/read-all
exports.markAllRead = async (req, res) => {
  try {
    const r = await Notification.updateMany(
      { user: req.user.id, isRead: false },
      { isRead: true }
    );
    res.json({ updated: r.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// DELETE /api/notification/:id
exports.remove = async (req, res) => {
  try {
    const n = await Notification.findOneAndDelete({
      _id: req.params.id,
      user: req.user.id,
    });
    if (!n) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
