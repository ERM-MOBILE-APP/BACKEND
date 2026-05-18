const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');

// ---- Office policy ----
// Each calendar month an employee gets:
//   • 1 paid leave
//   • 2 paid permissions
// Anything beyond these counts as LOP (Loss of Pay).
const MONTHLY_LEAVE_ALLOWED = 1;
const MONTHLY_PERMISSION_ALLOWED = 2;

/** Parse common date string formats into a JS Date. */
function parseDateString(s) {
  if (!s) return null;
  // ISO YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  // DD/MM/YYYY (front-end leave form default)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  // Fallback (e.g. "Nov 24, 2024")
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function inMonth(date, year, month0) {
  if (!date) return false;
  return date.getFullYear() === year && date.getMonth() === month0;
}

/**
 * GET /api/profile
 * Returns user with monthly leave/permission usage + LOP from office policy.
 */
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const now = new Date();
    const year = now.getFullYear();
    const month0 = now.getMonth();

    // Pull all requests once, filter in-memory (small data, simple logic)
    const requests = await Leave.find({
      user: req.user.id,
      status: { $in: ['pending', 'approved'] },
    });

    let leaveUsed = 0;
    let permissionUsed = 0;

    for (const r of requests) {
      if (r.requestType === 'permission') {
        const d = parseDateString(r.date);
        if (inMonth(d, year, month0)) permissionUsed += 1;
      } else if (r.requestType === 'leave') {
        // Count each day from startDate..endDate that falls inside this month
        const start = parseDateString(r.startDate);
        const end = parseDateString(r.endDate) || start;
        if (!start) continue;
        const cursor = new Date(start);
        while (cursor <= end) {
          if (inMonth(cursor, year, month0)) {
            // Half day counts as 0.5
            leaveUsed += r.isHalfDay ? 0.5 : 1;
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      }
    }

    const leaveBalance = Math.max(0, MONTHLY_LEAVE_ALLOWED - leaveUsed);
    const permissionBalance = Math.max(
      0,
      MONTHLY_PERMISSION_ALLOWED - permissionUsed
    );
    const lopLeave = Math.max(0, leaveUsed - MONTHLY_LEAVE_ALLOWED);
    const lopPermission = Math.max(
      0,
      permissionUsed - MONTHLY_PERMISSION_ALLOWED
    );

    res.json({
      ...user.toObject(),

      // What the profile card already reads:
      leaveBalance,
      permissionBalance,

      // Extra detail (use in the LOP card / breakdown later):
      policy: {
        monthlyLeaveAllowed: MONTHLY_LEAVE_ALLOWED,
        monthlyPermissionAllowed: MONTHLY_PERMISSION_ALLOWED,
      },
      usage: {
        month: now.toLocaleString('default', { month: 'long', year: 'numeric' }),
        leaveUsed,
        permissionUsed,
        lopLeave,
        lopPermission,
        lopTotal: lopLeave + lopPermission,
      },
    });
  } catch (err) {
    console.error('getProfile error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * PUT /api/profile/update
 * Updates editable profile fields.
 */
exports.updateProfile = async (req, res) => {
  try {
    const allowed = ['name', 'email', 'phone', 'dob', 'gender', 'designation'];
    const updates = {};
    allowed.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, select: '-password' }
    );

    res.json({ message: 'Profile updated', user });
  } catch (err) {
    console.error('updateProfile error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
