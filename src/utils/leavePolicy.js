/**
 * Tesco ERM — monthly leave & permission policy.
 *
 * Rules
 * ─────
 * 1. Each employee gets 1 unpaid leave day per calendar month for free.
 *    Anything beyond that is Loss of Pay (LOP).
 *
 * 2. Each employee gets 2 permission slots per calendar month for free.
 *    Each permission can be up to 2 hours. Beyond that:
 *      • a 3rd permission (or 4th, 5th...) is LOP — counted as half a
 *        day each, because permissions are short partial-day absences.
 *      • hours BEYOND 2 inside an allowed permission accumulate and
 *        convert to LOP at 8 excess hours = 1 LOP day. E.g. one 4-hour
 *        permission = 2 excess hours = 0.25 LOP day.
 *
 * 3. LOP totals from all three sources add together for the month.
 *
 * Where this is used
 * ──────────────────
 *  • profileController.getProfile  → returns to the mobile profile screen
 *  • attendanceController.getSummary → returns to the attendance page
 *  • authController.adminLeavePolicy → returns to admin.html
 *
 * Using the same module everywhere guarantees the numbers shown on the
 * mobile app and admin.html match exactly.
 */

const Leave      = require('../models/Leave');
const Attendance = require('../models/Attendance');

const MONTHLY_LEAVE_ALLOWED      = 1; // free paid CL days per month
const MONTHLY_PERMISSION_ALLOWED = 2; // free permission slots per month
const MAX_PERMISSION_HOURS       = 2; // each permission allowed up to this many hours
const HOURS_PER_LOP_DAY          = 8; // 8 hours of excess permission time = 1 LOP day

// Late-to-LOP conversion. Cumulative within the month — loops every 3 lates:
//   • 3 lates  = 0.5 LOP day
//   • 6 lates  = 1.0 LOP day
//   • 9 lates  = 1.5 LOP day  (scales linearly past 6)
// Anyone with fewer than 3 late check-ins in the month gets no LOP from lateness.
const LATES_PER_HALF_DAY_LOP     = 3;

// Beyond ordinary lateness (10:01-10:30) HR set a harder rule: a check-in
// past 10:30 is immediately 0.5 LOP for that day, regardless of how many
// other lates the employee has accumulated.
const HARD_LATE_HOUR_IST   = 10;
const HARD_LATE_MINUTE_IST = 30;

// Per-day attendance-derived LOP rules — folded into the totals below.
// Each early-checkout without an approved permission counts as 0.5 LOP.
const EARLY_CHECKOUT_LOP_PER_DAY = 0.5;

function parseDateString(s) {
  if (!s) return null;
  const m1 = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m1) return new Date(+m1[1], +m1[2] - 1, +m1[3]);
  const m2 = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) return new Date(+m2[3], +m2[2] - 1, +m2[1]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function inMonth(date, year, month0) {
  if (!date) return false;
  return date.getFullYear() === year && date.getMonth() === month0;
}

/**
 * Compute leave/permission usage + LOP for one user in one month.
 *
 * @param {string|ObjectId} userId
 * @param {number} year   — e.g. 2026
 * @param {number} month0 — 0..11 (JavaScript month index)
 * @returns {Promise<object>} structured policy result, suitable for direct
 *   inclusion in API responses.
 */
async function computeLeavePolicy(userId, year, month0) {
  const requests = await Leave.find({
    user: userId,
    status: { $in: ['pending', 'approved'] },
  });

  let leaveUsedDays         = 0;
  let permissionsUsed       = 0;
  let permissionHoursUsed   = 0;
  let permissionExcessHours = 0; // hours beyond 2 inside the 2 allowed permissions

  for (const r of requests) {
    if (r.requestType === 'permission') {
      const d = parseDateString(r.date);
      if (!inMonth(d, year, month0)) continue;
      permissionsUsed += 1;
      const hours = Number(r.durationHours || 0);
      permissionHoursUsed += hours;
      if (hours > MAX_PERMISSION_HOURS) {
        permissionExcessHours += hours - MAX_PERMISSION_HOURS;
      }
    } else if (r.requestType === 'leave') {
      const start = parseDateString(r.startDate);
      const end   = parseDateString(r.endDate) || start;
      if (!start) continue;
      const cursor = new Date(start);
      while (cursor <= end) {
        if (inMonth(cursor, year, month0)) {
          leaveUsedDays += r.isHalfDay ? 0.5 : 1;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }
  }

  // ── Late check-ins this month ──────────────────────────────────────
  // Anyone clocking in past 10:01 is flagged 'late' on their Attendance
  // row. Three lates roll into ½-day LOP, six into a full LOP day.
  const mm    = String(month0 + 1).padStart(2, '0');
  const start = `${year}-${mm}-01`;
  const end   = `${year}-${mm}-${String(new Date(year, month0 + 1, 0).getDate()).padStart(2, '0')}`;
  let lateCount = 0;
  let hardLateCount = 0;        // check-ins past 10:30 IST
  let earlyCheckoutCount = 0;   // checked out before scheduled end without approved permission
  try {
    lateCount = await Attendance.countDocuments({
      user:   userId,
      status: 'late',
      date:   { $gte: start, $lte: end },
    });

    // Inspect the month's rows to count hard-lates and unapproved early
    // checkouts. We pull the minimum fields needed so the query stays
    // cheap even on months with 30 rows × hundreds of employees.
    const rows = await Attendance.find({
      user: userId,
      date: { $gte: start, $lte: end },
    }).select('date checkIn checkOut earlyCheckoutLop status').lean();

    for (const r of rows) {
      // ── Hard late (>= 10:30 IST) → 0.5 LOP, separate from the 3-late rule.
      if (r.checkIn) {
        // Stamp the check-in in IST (UTC+5:30) and compare hours+minutes.
        const ist = new Date(new Date(r.checkIn).getTime() + (5 * 60 + 30) * 60 * 1000);
        const h = ist.getUTCHours();
        const m = ist.getUTCMinutes();
        if (h > HARD_LATE_HOUR_IST || (h === HARD_LATE_HOUR_IST && m > HARD_LATE_MINUTE_IST)) {
          hardLateCount += 1;
        }
      }
      // ── Early checkout flagged by the mobile/check-out endpoint.
      // The endpoint stamps `earlyCheckoutLop: true` when the employee
      // hit Check-Out before scheduled end AND there's no APPROVED
      // permission for that day. We just tally those rows here.
      if (r.earlyCheckoutLop) earlyCheckoutCount += 1;
    }
  } catch { /* collection not ready — non-fatal, counts stay 0 */ }

  // LOP buckets
  const lopFromExtraLeaveDays       = Math.max(0, leaveUsedDays   - MONTHLY_LEAVE_ALLOWED);
  const extraPermissionsCount       = Math.max(0, permissionsUsed - MONTHLY_PERMISSION_ALLOWED);
  // Each permission beyond the 2 allowed = half-day LOP (short absences)
  const lopFromExtraPermissions     = extraPermissionsCount * 0.5;
  // Excess hours from oversized permissions: 8 excess hrs = 1 LOP day
  const lopFromPermissionExcessHours = permissionExcessHours / HOURS_PER_LOP_DAY;
  // Late-check-in LOP: ½ day per LATES_PER_HALF_DAY_LOP cumulative lates.
  // floor() means the LOP only kicks in once the threshold is crossed —
  // 1 and 2 lates are still free.
  const lopFromLateCheckIns = Math.floor(lateCount / LATES_PER_HALF_DAY_LOP) * 0.5;
  // Hard-late = each check-in past 10:30 IST contributes 0.5 LOP directly.
  // This is independent of the 3-lates rule — a single 10:31 entry is
  // already half a day.
  const lopFromHardLates    = hardLateCount * 0.5;
  const lopFromEarlyCheckout = earlyCheckoutCount * EARLY_CHECKOUT_LOP_PER_DAY;
  const totalLopDays =
    lopFromExtraLeaveDays + lopFromExtraPermissions +
    lopFromPermissionExcessHours + lopFromLateCheckIns +
    lopFromHardLates + lopFromEarlyCheckout;

  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    month: month0 + 1,
    year,
    policy: {
      monthlyLeaveAllowed:      MONTHLY_LEAVE_ALLOWED,
      monthlyPermissionAllowed: MONTHLY_PERMISSION_ALLOWED,
      maxPermissionHours:       MAX_PERMISSION_HOURS,
      hoursPerLopDay:           HOURS_PER_LOP_DAY,
      latesPerHalfDayLop:       LATES_PER_HALF_DAY_LOP,
    },
    usage: {
      leaveUsedDays:         round2(leaveUsedDays),
      permissionsUsed,
      permissionHoursUsed:   round2(permissionHoursUsed),
      permissionExcessHours: round2(permissionExcessHours),
      lateCheckIns:          lateCount,
      hardLateCheckIns:      hardLateCount,
      earlyCheckouts:        earlyCheckoutCount,
    },
    balance: {
      leaveRemainingDays:    round2(Math.max(0, MONTHLY_LEAVE_ALLOWED - leaveUsedDays)),
      permissionsRemaining:  Math.max(0, MONTHLY_PERMISSION_ALLOWED - permissionsUsed),
    },
    lop: {
      fromExtraLeaveDays:        round2(lopFromExtraLeaveDays),
      fromExtraPermissions:      round2(lopFromExtraPermissions),
      fromPermissionExcessHours: round2(lopFromPermissionExcessHours),
      fromLateCheckIns:          round2(lopFromLateCheckIns),
      fromHardLates:             round2(lopFromHardLates),
      fromEarlyCheckouts:        round2(lopFromEarlyCheckout),
      totalDays:                 round2(totalLopDays),
    },
  };
}

module.exports = {
  computeLeavePolicy,
  MONTHLY_LEAVE_ALLOWED,
  MONTHLY_PERMISSION_ALLOWED,
  MAX_PERMISSION_HOURS,
  HOURS_PER_LOP_DAY,
  LATES_PER_HALF_DAY_LOP,
};
