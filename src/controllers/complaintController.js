const Complaint = require('../models/Complaint');
const { notify } = require('../utils/notify');

const ALLOWED_PRIORITY = ['low', 'medium', 'high', 'critical'];
const ALLOWED_STATUS   = ['open', 'in-progress', 'resolved', 'closed'];

/**
 * Admin auth — same pattern as authController.checkAdmin. Required for the
 * HRMS web app's complaint dashboard endpoints. The header must match the
 * ADMIN_SECRET env var on Render.
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

/**
 * POST /api/complaint
 * Body: { subject, priority, description }
 */
exports.create = async (req, res) => {
  try {
    const { subject, priority = 'low', description = '' } = req.body || {};

    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ message: 'Subject is required.' });
    }
    if (String(subject).length > 200) {
      return res.status(400).json({ message: 'Subject must be 200 characters or fewer.' });
    }
    if (String(description).length > 500) {
      return res.status(400).json({ message: 'Description must be 500 characters or fewer.' });
    }
    const cleanPriority = ALLOWED_PRIORITY.includes(String(priority).toLowerCase())
      ? String(priority).toLowerCase()
      : 'low';

    const created = await Complaint.create({
      user: req.user.id,
      subject: String(subject).trim(),
      description: String(description).trim(),
      priority: cleanPriority,
    });

    res.status(201).json({ message: 'Complaint submitted successfully.', complaint: created });
  } catch (err) {
    console.error('[complaint.create]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/complaint  (employee — own complaints only)
 */
exports.list = async (req, res) => {
  try {
    const items = await Complaint.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/complaint/:id  (employee — own complaint by id)
 */
exports.getOne = async (req, res) => {
  try {
    const item = await Complaint.findOne({ _id: req.params.id, user: req.user.id }).lean();
    if (!item) return res.status(404).json({ message: 'Complaint not found.' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ─── HR / Admin endpoints (consumed by the HRMS web app via its backend) ───
// Protected by the x-admin-secret header (same pattern as /api/auth/admin/*).

/**
 * GET /api/complaint/admin/all
 * Returns every complaint across all users, newest first, with the
 * submitter populated so the HRMS UI can show employee name/userId/email.
 * Includes a status summary for dashboard widgets.
 */
exports.adminListAll = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const q = {};
    const status   = String(req.query.status   || '').toLowerCase();
    const priority = String(req.query.priority || '').toLowerCase();
    if (ALLOWED_STATUS.includes(status))     q.status   = status;
    if (ALLOWED_PRIORITY.includes(priority)) q.priority = priority;

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const items = await Complaint.find(q)
      .populate('user', 'userId employeeId firstName lastName name email designation photoUrl department designationTitle departmentName')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const counts = await Complaint.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    const summary = { open: 0, 'in-progress': 0, resolved: 0, closed: 0, total: 0 };
    counts.forEach((c) => { summary[c._id] = c.n; summary.total += c.n; });

    res.json({ items, summary, shown: items.length });
  } catch (err) {
    console.error('[complaint.adminListAll]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * PATCH /api/complaint/admin/:id
 * Body: { status?, priority?, hrResponse? }
 * Updates a complaint and notifies the employee on status/response changes.
 */
exports.adminUpdate = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const id     = req.params.id;
    const update = {};
    const body   = req.body || {};

    if (body.status !== undefined) {
      const s = String(body.status).toLowerCase();
      if (!ALLOWED_STATUS.includes(s)) {
        return res.status(400).json({
          message: `status must be one of: ${ALLOWED_STATUS.join(', ')}`,
        });
      }
      update.status = s;
    }
    if (body.priority !== undefined) {
      const p = String(body.priority).toLowerCase();
      if (!ALLOWED_PRIORITY.includes(p)) {
        return res.status(400).json({
          message: `priority must be one of: ${ALLOWED_PRIORITY.join(', ')}`,
        });
      }
      update.priority = p;
    }
    if (typeof body.hrResponse === 'string') {
      update.hrResponse  = body.hrResponse.slice(0, 1000);
      update.respondedAt = new Date();
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        message: 'Send at least one of: status, priority, hrResponse.',
      });
    }

    const prev = await Complaint.findById(id);
    if (!prev) return res.status(404).json({ message: 'Complaint not found.' });

    const fresh = await Complaint.findByIdAndUpdate(id, update, { new: true })
      .populate('user', 'userId employeeId firstName lastName name email designation photoUrl department designationTitle departmentName');

    try {
      const statusChanged = update.status     && update.status !== prev.status;
      const responseAdded = update.hrResponse && update.hrResponse !== prev.hrResponse;
      if (statusChanged || responseAdded) {
        const title = statusChanged
          ? `Complaint ${update.status === 'resolved'    ? 'resolved ✓'
                       : update.status === 'in-progress' ? 'is being looked at'
                       : update.status === 'closed'      ? 'closed'
                       : 'updated'}`
          : 'HR replied to your complaint';
        const body = responseAdded
          ? `HR: "${update.hrResponse.length > 120 ? update.hrResponse.slice(0,120) + '…' : update.hrResponse}"`
          : `Your complaint "${prev.subject.slice(0, 60)}" is now ${update.status}.`;
        await notify(prev.user, {
          title, body, type: 'general', link: '/complaint',
        });
      }
    } catch (notifyErr) {
      console.error('[complaint.adminUpdate] notify failed:', notifyErr.message);
    }

    res.json({ message: 'Complaint updated.', complaint: fresh });
  } catch (err) {
    console.error('[complaint.adminUpdate]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
