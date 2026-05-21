const Leave = require('../models/Leave');

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
    const permission = await Leave.create({
      user: req.user.id,
      requestType: 'permission',
      permissionType,
      date,
      startTime,
      endTime,
      durationHours: hoursBetween(startTime, endTime),
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
      .populate('user', 'name userId')
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
