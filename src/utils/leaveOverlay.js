/**
 * #407 — Auto-overlay approved Leave / Permission onto attendance status.
 *
 * REQUIREMENT (from HR):
 *   • Approved Leave (BOTH manager AND HR approved) → date(s) show as 'leave'.
 *   • Approved Permission (BOTH manager AND HR approved) — three states:
 *       (a) NOW is within the permission window → show 'permission'
 *       (b) NOW is past the permission window AND employee has a check-in
 *           on the date → show 'present' (permission excused the lateness).
 *       (c) NOW is past the permission window AND NO check-in → 'absent'
 *           (permission alone is NOT a full day off).
 *   • For any past date, "NOW" is always past the permission window, so
 *     only branches (b) and (c) can fire.
 *   • HR manual override (`hrOverride: true`) ALWAYS wins — the automatic
 *     overlay never touches a row an HR manually flipped.
 *   • The overlay must NEVER mark someone Present who had no check-in.
 *
 * INPUT
 *   items    — attendance docs (lean) for the queried date range.
 *              Must have: user (populated), date (YYYY-MM-DD), status, checkIn.
 *   leaves   — leave docs (lean) for the queried date range.
 *              Must have: user, requestType, managerStatus, status, date
 *              (permission) or startDate/endDate (leave), startTime/endTime.
 *   opts     — { rangeStart, rangeEnd } (YYYY-MM-DD strings).
 *
 * OUTPUT
 *   { items } — the mutated items array. New synthetic rows are appended
 *   when a leave/permission covers a date with no real attendance row.
 *   Existing rows have `status` (and sometimes `_leaveOverlay: true`)
 *   updated in-place.
 *
 * PRECONDITION for override
 *   lv.managerStatus === 'Approved'  AND  lv.status === 'approved'
 * (both tiers must sign off — a manager-only approval or HR-only approval
 *  is NOT enough).
 */

/** Build the IST wall-clock Date for a permission's end instant. */
function permissionEndInstantIST(dateStr, endTimeStr) {
  if (!dateStr || !endTimeStr) return null;
  // endTimeStr is "HH:MM" (24-hour). Force IST offset so this works from
  // any TZ the server happens to run in.
  const t = String(endTimeStr).trim();
  const hhmm = /^\d{1,2}:\d{2}$/.test(t) ? t.padStart(5, '0') : null;
  if (!hhmm) return null;
  const d = new Date(`${dateStr}T${hhmm}:00+05:30`);
  return isNaN(d.getTime()) ? null : d;
}

/** All YYYY-MM-DD dates in [rangeStart, rangeEnd] that the leave covers. */
function coveredDates(lv, rangeStart, rangeEnd) {
  const out = [];
  if (lv.requestType === 'permission') {
    if (lv.date && lv.date >= rangeStart && lv.date <= rangeEnd) out.push(lv.date);
    return out;
  }
  const s = new Date(Math.max(new Date(lv.startDate || rangeStart), new Date(rangeStart)));
  const e = new Date(Math.min(new Date(lv.endDate   || rangeStart), new Date(rangeEnd)));
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return out;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Main entry.
 * items[i] MAY be mutated in-place with a new `status`.
 * Also adds `_leaveOverlay: true` on modified rows and on synthesised rows.
 */
function applyLeavePermissionOverlay(items, leaves, { rangeStart, rangeEnd, now = new Date() } = {}) {
  const nowMs = now.getTime();

  // Only apply overlay when BOTH tiers approved.
  const eligible = (leaves || []).filter(
    lv => lv && lv.managerStatus === 'Approved' && lv.status === 'approved'
  );

  // Index existing items by "userId|date" so we can find and mutate them
  // instead of duplicating.
  const byKey = new Map();
  for (const a of (items || [])) {
    const uid = String(a.user?._id || a.user || '');
    if (!uid || !a.date) continue;
    byKey.set(uid + '|' + a.date, a);
  }

  const synthetic = [];

  for (const lv of eligible) {
    if (!lv.user) continue;
    const uid = String(lv.user._id || lv.user);
    const dates = coveredDates(lv, rangeStart, rangeEnd);

    for (const date of dates) {
      const key = uid + '|' + date;
      const existing = byKey.get(key);

      // ── Approved LEAVE (full-day). Status = 'leave' always. ─────
      if (lv.requestType === 'leave') {
        if (existing) {
          // Preserve HR manual override — HR wins over auto overlay.
          if (existing.hrOverride === true) continue;
          existing.status = 'leave';
          existing._leaveOverlay = true;
          existing._leaveType    = lv.leaveType || '';
        } else {
          synthetic.push({
            _id:    'lv-' + lv._id + '-' + date,
            user:   lv.user,
            date,
            status: 'leave',
            checkIn:  null,
            checkOut: null,
            isOverlay: true,
            _leaveOverlay: true,
            leaveType: lv.leaveType || '',
            reason:    lv.reason    || '',
          });
        }
        continue;
      }

      // ── Approved PERMISSION (time-window). Three-state logic. ───
      if (lv.requestType === 'permission') {
        const permEnd  = permissionEndInstantIST(date, lv.endTime);
        const nowInWindow = permEnd ? nowMs < permEnd.getTime() : false;

        if (existing) {
          if (existing.hrOverride === true) continue;
          if (nowInWindow) {
            existing.status = 'permission';
            existing._leaveOverlay = true;
          } else if (existing.checkIn) {
            // Past permission window + they clocked in → Present.
            // This is the key fix: an employee who checked in late but
            // had permission covering the lateness should NOT be Absent.
            existing.status = 'present';
            existing._leaveOverlay = true;
          } else {
            // Past permission window + never checked in → Absent.
            existing.status = 'absent';
            existing._leaveOverlay = true;
          }
        } else {
          // No attendance row at all. Synthesise one so the row appears
          // on HR's Attendance Logs. Permission alone without a check-in
          // means Absent once the window closes.
          synthetic.push({
            _id:    'pm-' + lv._id + '-' + date,
            user:   lv.user,
            date,
            status: nowInWindow ? 'permission' : 'absent',
            checkIn:  null,
            checkOut: null,
            startTime: lv.startTime || null,
            endTime:   lv.endTime   || null,
            durationHours: lv.durationHours || null,
            isOverlay: true,
            _leaveOverlay: true,
            leaveType: lv.permissionType || '',
            reason:    lv.reason || '',
          });
        }
      }
    }
  }

  items.push(...synthetic);
  return items;
}

module.exports = {
  applyLeavePermissionOverlay,
  permissionEndInstantIST,
  coveredDates,
};
