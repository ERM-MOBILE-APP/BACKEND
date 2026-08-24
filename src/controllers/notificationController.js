const Notification = require('../models/Notification');
const User = require('../models/User');
const DeviceToken = require('../models/DeviceToken');

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
