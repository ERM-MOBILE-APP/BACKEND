const Announcement = require('../models/Announcement');

// GET /api/announcement
// Returns the latest active announcements (most recent first)
exports.list = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const items = await Announcement.find({ isActive: true })
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(items);
  } catch (err) {
    console.error('announcement.list error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/announcement/:id
exports.getById = async (req, res) => {
  try {
    const a = await Announcement.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Not found' });
    res.json(a);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/announcement   (HR / admin)
// body: { title, body, category?, postedBy?, audience? }
exports.create = async (req, res) => {
  try {
    const { title, body, category, postedBy, audience } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ message: 'title and body are required' });
    }
    const a = await Announcement.create({
      title,
      body,
      category,
      postedBy: postedBy || 'HR',
      audience,
    });
    res.status(201).json(a);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// PATCH /api/announcement/:id    (HR / admin)
exports.update = async (req, res) => {
  try {
    const a = await Announcement.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!a) return res.status(404).json({ message: 'Not found' });
    res.json(a);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// DELETE /api/announcement/:id   (HR / admin) — soft delete
exports.remove = async (req, res) => {
  try {
    const a = await Announcement.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!a) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Archived', a });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
