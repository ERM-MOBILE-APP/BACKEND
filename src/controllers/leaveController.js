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

/**
 * Format an ISO/yyyy-mm-dd string as dd-mm-yyyy for user-facing errors.
 * Keeps the policy messages consistent with the HRMS-wide date format.
 */
function fmtDDMMYYYY(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

/**
 * Expand a leave date range to the list of YYYY-MM-DD strings it covers.
 * Used by the duplicate-day check so a leave from Jun 3-Jun 5 also blocks
 * a permission request for Jun 4.
 */
function expandRange(startDate, endDate) {
  const parse = (s) => {
    if (!s) return null;
    const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  const s = parse(startDate);
  const e = parse(endDate) || s;
  if (!s) return [];
  const out = [];
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(iso);
    if (out.length > 90) break;   // safety cap
  }
  return out;
}

/**
 * Find any non-cancelled leave or permission the user already has on
 * any of the given dates. Returns the first match or null.
 *
 * Used by applyLeave / applyPermission to enforce HR policy:
 *   - cannot have 2 permissions for the same day
 *   - cannot have both a leave and a permission for the same day
 *   - cannot apply for a leave on a day already inside another leave
 *
 * 'rejected' and 'cancelled' rows are ignored — they don't block.
 */
async function findClashingRequest(userId, dates) {
  if (!Array.isArray(dates) || dates.length === 0) return null;
  // Pull every non-final-rejected row in one query then filter in JS — far
  // cheaper than N queries per date when the user has a long leave history.
  const rows = await Leave.find({
    user: userId,
    status: { $nin: ['rejected', 'cancelled'] },
  }).lean();

  const want = new Set(dates);
  for (const r of rows) {
    if (r.requestType === 'permission') {
      const d = String(r.date || '').slice(0, 10);
      if (d && want.has(d)) return r;
    } else if (r.requestType === 'leave') {
      const span = expandRange(r.startDate, r.endDate);
      for (const d of span) if (want.has(d)) return r;
    }
  }
  return null;
}

// POST /api/leave/apply
exports.applyLeave = async (req, res) => {
  try {
    const { leaveType, startDate, endDate, isHalfDay, reason } = req.body;
    if (!leaveType || !startDate || !endDate || !reason) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // ── Same-day clash check ──────────────────────────────────────────
    // Block if any day in the requested range already has a leave or
    // permission on file (pending or approved). Returns 409 + a message
    // that names the clashing day in dd-mm-yyyy.
    const dates = expandRange(startDate, endDate);
    const clash = await findClashingRequest(req.user.id, dates);
    if (clash) {
      const clashDay = clash.requestType === 'permission'
        ? clash.date
        : (dates.find(d => expandRange(clash.startDate, clash.endDate).includes(d)) || clash.startDate);
      return res.status(409).json({
        code: 'ALREADY_REQUESTED',
        message: `Already requested for ${fmtDDMMYYYY(clashDay)}`,
        existing: {
          id: String(clash._id),
          type: clash.requestType,
          status: clash.status,
        },
      });
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
    // Live-notify the employee's manager so it lands on their bell.
    try {
      const { notifyManagerOfRequest } = require('../utils/notifyManager');
      notifyManagerOfRequest(req.user.id, {
        type: 'leave',
        summary: `${leaveType} ${startDate}${endDate && endDate !== startDate ? ` → ${endDate}` : ''}`,
      }).catch(() => {});
    } catch (_) { /* best-effort */ }
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

    // ── Same-day clash check ──────────────────────────────────────────
    // Policy: only one permission per day, and no permission on a day
    // already covered by a leave. Returns 409 with a friendly message
    // so the UI can render a "Already requested for {date}" pop-up.
    const dayIso = String(date).slice(0, 10);
    const clash = await findClashingRequest(req.user.id, [dayIso]);
    if (clash) {
      return res.status(409).json({
        code: 'ALREADY_REQUESTED',
        message: `Already requested for ${fmtDDMMYYYY(dayIso)}`,
        existing: {
          id: String(clash._id),
          type: clash.requestType,
          status: clash.status,
        },
      });
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
    try {
      const { notifyManagerOfRequest } = require('../utils/notifyManager');
      notifyManagerOfRequest(req.user.id, {
        type: 'leave',
        kindLabel: 'permission request',
        summary: `Permission ${date} (${startTime}–${endTime})`,
      }).catch(() => {});
    } catch (_) { /* best-effort */ }
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

    // #472 — OPTIONAL date-range filter keyed on the leave's OWN dates
    // (startDate/endDate for leave, date for permission) — NOT createdAt /
    // reviewedAt / approval time. This fixes the HRMS calendar dropping an
    // approved request from its requested date: previously this endpoint
    // returned only the 200 most-recently-CREATED approved rows, so a leave
    // requested for a past date (created earlier) fell below the cutoff and
    // vanished from the calendar once ~200 newer requests existed. When a
    // from/to range is supplied, we match by the requested date and lift the
    // cap so every request overlapping the viewed month is returned,
    // regardless of when it was created or approved.
    const from = String(req.query.from || '').slice(0, 10);
    const to   = String(req.query.to   || '').slice(0, 10);
    const hasRange =
      /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);

    let query = q;
    if (hasRange) {
      const dateOr = {
        $or: [
          // A leave covers the range if it starts on/before `to` and ends on/after `from`.
          { requestType: 'leave',      startDate: { $lte: to }, endDate: { $gte: from } },
          // A permission lands in the range if its date is within [from, to].
          { requestType: 'permission', date: { $gte: from, $lte: to } },
        ],
      };
      query = Object.keys(q).length ? { $and: [q, dateOr] } : dateOr;
    }

    // With an explicit range, return everything in it (high cap) so nothing
    // is dropped; without a range, keep the legacy recent-N behaviour.
    const limit = hasRange
      ? Math.min(parseInt(req.query.limit, 10) || 2000, 5000)
      : Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const items = await Leave.find(query)
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
    const { status, hrComment, reviewedBy, managerStatus } = req.body || {};
    // Either a status flip OR a managerStatus flip is enough — the HRMS
    // Manager Approve button sends only `managerStatus` and used to be
    // rejected by the old status-only validator. We also keep the legacy
    // shape working (status without managerStatus).
    const wantsStatus        = status !== undefined && status !== null && status !== '';
    const wantsManagerStatus = managerStatus !== undefined && managerStatus !== null && managerStatus !== '';
    if (!wantsStatus && !wantsManagerStatus) {
      return res.status(400).json({ message: 'status or managerStatus required' });
    }
    if (wantsStatus && !['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'status must be approved, rejected, or pending' });
    }
    if (wantsManagerStatus && !['approved', 'rejected', 'pending', ''].includes(String(managerStatus).toLowerCase())) {
      return res.status(400).json({ message: 'managerStatus must be approved, rejected, or pending' });
    }
    const prev = await Leave.findById(req.params.id);
    if (!prev) return res.status(404).json({ message: 'Leave not found' });

    const update = { reviewedAt: new Date() };
    if (wantsStatus)         update.status        = status;
    if (wantsManagerStatus)  update.managerStatus = String(managerStatus).toLowerCase();
    if (typeof hrComment  === 'string') update.hrComment  = hrComment;
    if (typeof reviewedBy === 'string') update.reviewedBy = reviewedBy;

    const fresh = await Leave.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('user', 'userId employeeId firstName lastName name email designation photoUrl department designationTitle departmentName');

    // Fire notification on a REAL transition. Two independent paths:
    //   1. HR final action  → status flipped to approved / rejected
    //   2. Manager action   → managerStatus flipped to approved / rejected
    // The earlier version only handled path 1, so a manager rejection on
    // ERM Web never reached the employee's bell (issue from task #129/136).
    try {
      const kind = fresh.requestType === 'permission' ? 'Permission' : 'Leave';
      const when = fresh.requestType === 'permission'
        ? `${fresh.date} (${fresh.startTime}–${fresh.endTime})`
        : `${fresh.startDate}` +
          (fresh.endDate && fresh.endDate !== fresh.startDate ? ` – ${fresh.endDate}` : '');

      // Path 1 — HR status changed to approved / rejected.
      if (wantsStatus && status !== prev.status && (status === 'approved' || status === 'rejected')) {
        await notify(fresh.user, {
          title: `${kind} ${status} by HR`,
          body:  `Your ${kind.toLowerCase()} request for ${when} was ${status} by HR.` +
                 (hrComment ? ` Note: "${hrComment}"` : ''),
          type:  'leave',
          link:  '/(tabs)/leave',
        });
        console.log(`[leave.adminUpdate] HR ${status} notif sent for leave ${fresh._id}`);
      }

      // Path 2 — manager flipped managerStatus to approved / rejected,
      // and no HR status transition was sent in the same call.
      const newMgr = String(update.managerStatus || '').toLowerCase();
      const oldMgr = String(prev.managerStatus  || '').toLowerCase();
      if (
        wantsManagerStatus &&
        newMgr !== oldMgr &&
        (newMgr === 'approved' || newMgr === 'rejected') &&
        !(wantsStatus && status !== prev.status)        // avoid duplicate notif when both flip
      ) {
        const actor = reviewedBy && /manager/i.test(reviewedBy)
          ? `your manager (${reviewedBy})`
          : 'your manager';
        await notify(fresh.user, {
          title: `${kind} ${newMgr} by Manager`,
          body:  `Your ${kind.toLowerCase()} request for ${when} was ${newMgr} by ${actor}.` +
                 (hrComment ? ` Note: "${hrComment}"` : ''),
          type:  'leave',
          link:  '/(tabs)/leave',
        });
        console.log(`[leave.adminUpdate] MGR ${newMgr} notif sent for leave ${fresh._id}`);
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
