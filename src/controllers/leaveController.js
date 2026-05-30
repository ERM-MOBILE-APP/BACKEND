const Leave = require('../models/Leave');
const { notify } = require('../utils/notify');

/**
 * Admin auth — required for HR endpoints consumed by the HRMS web app
 * via its backend proxy. Header must match ADMIN_SECRET env var.
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

function daysBetween(start, end, isHalfDay) {
  if (!start || !end) return 0;
  const parse = (s) => {
    const d1 = new Date(s);
    if (!isNaN(d1.getTime())) return d1;
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    return null;
  };
  const s = parse(start);
  const e = parse(end);
  if (!s || !e) return 0;
  const diff = Math.round((e - s) / 86400000) + 1;
  if (isHalfDay) return 0.5;
  return Math.max(diff, 1);
}

function hoursBetween(start, end) {
  if (!start || !end) return 0;
  const toMin = (s) => {
    const parts = String(s).split(':');
    if (parts.length < 2) return null;
    const h = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(mm)) return null;
    return h * 60 + mm;
  };
  const a = toMin(start);
  const b = toMin(end);
  if (a == null || b == null) return 0;
  let diff = b - a;
  if (diff < 0) diff += 24 * 60;
  return Math.round((diff / 60) * 100) / 100;
}

// POST /api/leave/apply
exports.applyLeave = async (req, res) => {
  try {
    const { leaveType, startDate, endDate, isHalfDay, reason } = req.body;
    if (!leaveType || !startDate || !endDate || !reason) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const leave = await Leave.create({
      user: req.user.id,
      requestType: 'leave',
      leaveType,
      startDate,
      endDate,
      isHalfDay: !!isHalfDay,
      daysCount: daysBetween(startDate, endDate, !!isHalfDay),
      reason,
    });
    res.status(201).json({ message: 'Leave applied successfully', leave });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/leave/permission
exports.applyPermission = async (req, res) => {
  try {
    const { permissionType, date, startTime, endTime, reason } = req.body;
    if (!permissionType || !date || !startTime || !endTime || !reason) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    // Policy cap: each permission slot is at most 2 hours. Anything
    // longer would functionally be half a workday — those need a
    // proper Leave application, not a permission.
    const hours = hoursBetween(startTime, endTime);
    if (hours > 2 + 1e-6) {
      return res.status(400).json({
        message: 'Each permission can be at most 2 hours. Apply for a Leave (half-day) if you need longer.',
      });
    }
    if (hours <= 0) {
      return res.status(400).json({ message: 'End time must be after start time.' });
    }
    const permission = await Leave.create({
      user: req.user.id,
      requestType: 'permission',
      permissionType,
      date,
      startTime,
      endTime,
      durationHours: hours,
      reason,
    });
    res.status(201).json({ message: 'Permission applied successfully', permission });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/leave/me?month=&year=&type=
exports.getMyLeaves = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    const type = req.query.type;

    const q = { user: req.user.id };
    if (type === 'leave' || type === 'permission') q.requestType = type;

    let leaves = await Leave.find(q).sort({ createdAt: -1 }).lean();

    if (month && year) {
      leaves = leaves.filter((l) => {
        const ref = l.startDate || l.date || l.createdAt;
        const d = new Date(ref);
        if (isNaN(d.getTime())) return false;
        return d.getFullYear() === year && d.getMonth() + 1 === month;
      });
    }

    res.json(leaves);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.getAllLeaves = async (req, res) => {
  try {
    const leaves = await Leave.find()
      .populate('user', 'name userId designation department designationTitle departmentName')
      .sort({ createdAt: -1 });
    res.json(leaves);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.updateLeaveStatus = async (req, res) => {
  try {
    const { status, hrComment, reviewedBy } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const update = { status, reviewedAt: new Date() };
    if (typeof hrComment === 'string') update.hrComment = hrComment;
    if (typeof reviewedBy === 'string') update.reviewedBy = reviewedBy;

    const leave = await Leave.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!leave) return res.status(404).json({ message: 'Leave not found' });
    res.json(leave);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.cancelLeave = async (req, res) => {
  try {
    const leave = await Leave.findOne({ _id: req.params.id, user: req.user.id });
    if (!leave) return res.status(404).json({ message: 'Leave not found' });
    if (leave.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending requests can be cancelled' });
    }
    await leave.deleteOne();
    res.json({ message: 'Cancelled' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.getLeaveTypes = async (_req, res) => {
  res.json([
    { value: 'Casual Leave', label: 'Casual Leave' },
    { value: 'Sick Leave', label: 'Sick Leave' },
    { value: 'Earned Leave', label: 'Earned Leave' },
    { value: 'Unpaid Leave', label: 'Unpaid Leave' },
  ]);
};

exports.getPermissionTypes = async (_req, res) => {
  res.json([
    { value: 'Personal', label: 'Personal' },
    { value: 'Medical', label: 'Medical' },
    { value: 'Official', label: 'Official' },
    { value: 'Other', label: 'Other' },
  ]);
};

exports.getLeaveBalance = async (req, res) => {
  try {
    const User = require('../models/User');
    const u = await User.findById(req.user.id).lean();
    if (!u) return res.status(404).json({ message: 'User not found' });
    res.json({
      leaveBalance: u.leaveBalance || 0,
      permissionBalance: u.permissionBalance || 0,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ─── HR / Admin endpoints (consumed by HRMS web app via backend proxy) ─────
// Both require the x-admin-secret header.

/**
 * GET /api/leave/admin/all
 *   ?type=leave|permission   (optional)
 *   ?status=pending|approved|rejected   (optional)
 *   ?limit=200               (default 200, max 500)
 *
 * Returns every leave/permission across all users with the submitter
 * populated so HRMS can show name + designation + email without an
 * extra round-trip.
 */
exports.adminListAll = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const q = {};
    const type   = String(req.query.type   || '').toLowerCase();
    const status = String(req.query.status || '').toLowerCase();
    if (type === 'leave' || type === 'permission') q.requestType = type;
    if (['pending', 'approved', 'rejected'].includes(status)) q.status = status;

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const items = await Leave.find(q)
      .populate('user', 'userId employeeId firstName lastName name email designation photoUrl department designationTitle departmentName')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Counts the HRMS dashboard wants — pending breakdown by type.
    const counts = await Leave.aggregate([
      { $group: {
          _id: { type: '$requestType', status: '$status' },
          n:   { $sum: 1 },
      } },
    ]);
    const summary = {
      total: items.length,
      pendingLeaves:      0,
      pendingPermissions: 0,
      approvedLeaves:     0,
      approvedPermissions:0,
      rejectedLeaves:     0,
      rejectedPermissions:0,
    };
    counts.forEach((c) => {
      const t = c._id.type, s = c._id.status;
      if      (s === 'pending'  && t === 'leave')      summary.pendingLeaves      = c.n;
      else if (s === 'pending'  && t === 'permission') summary.pendingPermissions = c.n;
      else if (s === 'approved' && t === 'leave')      summary.approvedLeaves     = c.n;
      else if (s === 'approved' && t === 'permission') summary.approvedPermissions= c.n;
      else if (s === 'rejected' && t === 'leave')      summary.rejectedLeaves     = c.n;
      else if (s === 'rejected' && t === 'permission') summary.rejectedPermissions= c.n;
    });

    res.json({ items, summary, shown: items.length });
  } catch (err) {
    console.error('[leave.adminListAll]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * PATCH /api/leave/admin/:id
 * Body: { status, hrComment?, reviewedBy? }
 *
 * HR approves/rejects a leave or permission. Notifies the employee in-app
 * when the status changes to approved or rejected.
 */
exports.adminUpdate = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { status, hrComment, reviewedBy } = req.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'status must be approved, rejected, or pending' });
    }
    const prev = await Leave.findById(req.params.id);
    if (!prev) return res.status(404).json({ message: 'Leave not found' });

    const update = { status, reviewedAt: new Date() };
    if (typeof hrComment  === 'string') update.hrComment  = hrComment;
    if (typeof reviewedBy === 'string') update.reviewedBy = reviewedBy;

    const fresh = await Leave.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('user', 'userId employeeId firstName lastName name email designation photoUrl department designationTitle departmentName');

    // Fire notification on real status transition (approved or rejected).
    try {
      if (status !== prev.status && (status === 'approved' || status === 'rejected')) {
        const kind = fresh.requestType === 'permission' ? 'Permission' : 'Leave';
        const when = fresh.requestType === 'permission'
          ? `${fresh.date} (${fresh.startTime}–${fresh.endTime})`
          : `${fresh.startDate}` +
            (fresh.endDate && fresh.endDate !== fresh.startDate ? ` – ${fresh.endDate}` : '');
        await notify(fresh.user, {
          title: `${kind} ${status === 'approved' ? 'approved ✓' : 'rejected'}`,
          body:  `Your ${kind.toLowerCase()} request for ${when} was ${status} by HR.` +
                 (hrComment ? ` Note: "${hrComment}"` : ''),
          type:  'leave',
          link:  '/(tabs)/leave',
        });
      }
    } catch (notifyErr) {
      console.error('[leave.adminUpdate] notify failed:', notifyErr.message);
    }

    res.json({ message: 'Leave updated.', leave: fresh });
  } catch (err) {
    console.error('[leave.adminUpdate]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
