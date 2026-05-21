const Notification = require('../models/Notification');

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
