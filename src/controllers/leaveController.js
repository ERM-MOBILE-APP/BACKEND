const Leave = require('../models/Leave');

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
      reason,
    });

    res.status(201).json({ message: 'Permission applied successfully', permission });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/leave/me
exports.getMyLeaves = async (req, res) => {
  try {
    const leaves = await Leave.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json(leaves);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/leave  (admin / manager view)
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

// PATCH /api/leave/:id/status
exports.updateLeaveStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const leave = await Leave.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!leave) return res.status(404).json({ message: 'Leave not found' });
    res.json(leave);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
