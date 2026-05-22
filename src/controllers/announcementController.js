const Announcement = require('../models/Announcement');

/**
 * Admin auth — required for HR endpoints consumed by the HRMS web app via
 * its backend proxy. Header must match the ADMIN_SECRET env var.
 */
function checkAdmin(req, res) {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) {
    res.status(503).json({ message: 'ADMIN_SECRET is not configured on the server.' });
    return false;
  }
  if (!got || got !== expected) {
    res.status(401).json({ message: 'Missing or invalid x-admin-secret header.' });
    return false;
  }
  return true;
}

// Mobile schema enum is: holiday | policy | event | general. HRMS uses
// freeform strings ('Holiday', 'Company Policy', 'Event', etc.). Map them.
function normalizeCategory(c) {
  if (!c) return 'general';
  const s = String(c).toLowerCase();
  if (s.includes('holiday')) return 'holiday';
  if (s.includes('policy'))  return 'policy';
  if (s.includes('event'))   return 'event';
  return 'general';
}
function normalizeAudience(a) {
  if (!a) return 'all';
  const s = String(a).toLowerCase();
  if (s.includes('depart')) return 'department';
  if (s.includes('team'))   return 'team';
  return 'all';
}

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

// ─── HR / Admin endpoints (consumed by HRMS via backend proxy) ─────────
// Identical behavior to create/update/remove above but auth via
// x-admin-secret header instead of JWT. HRMS announcements posted by HR
// flow into the mobile app via these endpoints — every employee then
// sees them in their Announcements section.

/**
 * POST /api/announcement/admin
 * Body: { title, body, category?, postedBy?, audience?, externalId? }
 *
 * externalId (optional) is the HRMS document _id — we store it on the
 * mobile doc so update/delete from HRMS can find the right row later.
 */
exports.adminCreate = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { title, body, category, postedBy, audience, externalId } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ message: 'title and body are required' });
    }
    // If externalId already exists, treat as upsert — refresh that row
    // instead of creating a duplicate.
    if (externalId) {
      const existing = await Announcement.findOne({ externalId });
      if (existing) {
        existing.title    = String(title).trim();
        existing.body     = String(body).trim();
        existing.category = normalizeCategory(category);
        existing.postedBy = postedBy ? String(postedBy).trim() : 'HR';
        existing.audience = normalizeAudience(audience);
        existing.isActive = true;
        await existing.save();
        return res.status(200).json({ message: 'Synced (existing)', announcement: existing });
      }
    }
    const a = await Announcement.create({
      title:    String(title).trim(),
      body:     String(body).trim(),
      category: normalizeCategory(category),
      postedBy: postedBy ? String(postedBy).trim() : 'HR',
      audience: normalizeAudience(audience),
      externalId: externalId || undefined,
    });
    res.status(201).json({ message: 'Created', announcement: a });
  } catch (err) {
    console.error('[announcement.adminCreate]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * PATCH /api/announcement/admin/by-external/:externalId
 * Update the mobile copy of an HRMS-posted announcement.
 */
exports.adminUpdateByExternalId = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const update = {};
    const b = req.body || {};
    if (b.title    !== undefined) update.title    = String(b.title).trim();
    if (b.body     !== undefined) update.body     = String(b.body).trim();
    if (b.category !== undefined) update.category = normalizeCategory(b.category);
    if (b.postedBy !== undefined) update.postedBy = String(b.postedBy).trim() || 'HR';
    if (b.audience !== undefined) update.audience = normalizeAudience(b.audience);
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'No updatable fields supplied.' });
    }
    const a = await Announcement.findOneAndUpdate(
      { externalId: req.params.externalId },
      update,
      { new: true }
    );
    if (!a) return res.status(404).json({ message: 'No mobile copy exists for that externalId' });
    res.json({ message: 'Updated', announcement: a });
  } catch (err) {
    console.error('[announcement.adminUpdateByExternalId]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * DELETE /api/announcement/admin/by-external/:externalId — soft delete
 */
exports.adminRemoveByExternalId = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const a = await Announcement.findOneAndUpdate(
      { externalId: req.params.externalId },
      { isActive: false },
      { new: true }
    );
    if (!a) return res.status(404).json({ message: 'No mobile copy exists for that externalId' });
    res.json({ message: 'Archived', announcement: a });
  } catch (err) {
    console.error('[announcement.adminRemoveByExternalId]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
