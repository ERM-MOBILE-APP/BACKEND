const mongoose = require('mongoose');
const User     = require('../models/User');
const Leave    = require('../models/Leave');
let Department, Designation;
try { Department  = require('../models/Department');  } catch { Department  = null; }
try { Designation = require('../models/Designation'); } catch { Designation = null; }

const isObjId = (v) => v && /^[a-f0-9]{24}$/i.test(String(v));

/**
 * Resolve a possibly-ObjectId reference to a human label by looking it up
 * in the matching collection. Falls back to the raw value (or '') when the
 * ID doesn't resolve.
 */
async function resolveLabel(value, kind) {
  if (!value) return '';
  if (!isObjId(value)) return String(value);
  try {
    if (kind === 'dept' && Department) {
      const d = await Department.findById(value).lean();
      return d?.name || '';
    }
    if (kind === 'desig' && Designation) {
      const d = await Designation.findById(value).lean();
      return d?.title || '';
    }
    // Fall back to a raw `departments` / `designations` collection lookup
    // when the Mongoose model isn't registered on the mobile backend.
    const coll = kind === 'dept' ? 'departments' : 'designations';
    const db   = mongoose.connection.db;
    const doc  = await db.collection(coll).findOne({ _id: new mongoose.Types.ObjectId(value) });
    return doc?.name || doc?.title || '';
  } catch {
    return '';
  }
}

/** Flatten an address object into "Street, City, State, Pincode, Country". */
function flattenAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  if (typeof addr === 'object') {
    return [addr.street, addr.city, addr.state, addr.zipCode, addr.country]
      .filter(Boolean).join(', ');
  }
  return String(addr);
}

const MONTHLY_LEAVE_ALLOWED = 1;
const MONTHLY_PERMISSION_ALLOWED = 2;

function parseDateString(s) {
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
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
        const start = parseDateString(r.startDate);
        const end = parseDateString(r.endDate) || start;
        if (!start) continue;
        const cursor = new Date(start);
        while (cursor <= end) {
          if (inMonth(cursor, year, month0)) {
            leaveUsed += r.isHalfDay ? 0.5 : 1;
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      }
    }

    const leaveBalance = Math.max(0, MONTHLY_LEAVE_ALLOWED - leaveUsed);
    const permissionBalance = Math.max(0, MONTHLY_PERMISSION_ALLOWED - permissionUsed);
    const lopLeave = Math.max(0, leaveUsed - MONTHLY_LEAVE_ALLOWED);
    const lopPermission = Math.max(0, permissionUsed - MONTHLY_PERMISSION_ALLOWED);

    // Translate ObjectId references to readable strings before the mobile
    // UI gets them. Without this, Designation/Department/Address fields
    // show raw hex or '[object Object]'.
    const u = user.toObject();
    const [deptLabel, desigLabel] = await Promise.all([
      resolveLabel(u.department,  'dept'),
      resolveLabel(u.designation, 'desig'),
    ]);
    u.department  = deptLabel;
    u.designation = desigLabel;
    u.address     = flattenAddress(u.address);

    res.json({
      ...u,
      leaveBalance,
      permissionBalance,
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
 */
exports.updateProfile = async (req, res) => {
  try {
    const allowed = [
      'name',
      'email',
      'phone',
      'dob',
      'gender',
      'designation',
      'bloodGroup',
      'photoUrl',
      'address',
    ];
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
