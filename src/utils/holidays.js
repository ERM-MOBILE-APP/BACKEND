/**
 * Tesco ERM — government / company holiday calendar.
 *
 * HR uploads a PDF list of public holidays each year. We mirror the
 * relevant dates here so the attendance + LOP computations on the
 * backend can treat them as PAID PRESENT days (the employee doesn't
 * have to check in, and the day doesn't count toward "absent").
 *
 * Maintained inline because the list is small (~10 entries/year) and
 * changes once a year. To update: edit the HOLIDAYS array below — keep
 * dates in ISO yyyy-mm-dd format so the lookup is O(1) via the Set.
 *
 * Sundays are computed dynamically (no need to enumerate). Saturdays
 * are working days unless they appear in the holiday list explicitly.
 */

const HOLIDAYS = [
  // ── 2025 ─────────────────────────────────────────────────────────────
  { date: '2025-04-14', name: 'Tamil New Year' },
  { date: '2025-05-01', name: 'May Day' },
  { date: '2025-08-15', name: 'Independence Day' },
  { date: '2025-10-02', name: 'Gandhi Jayanthi' },
  { date: '2025-10-21', name: 'Ayutha Pooja' },
  { date: '2025-10-22', name: 'Ayutha Pooja' },
  { date: '2025-10-20', name: 'Diwali' },
  { date: '2025-12-25', name: 'Christmas' },

  // ── 2026 (per HOLIDAY CALENDAR.pdf received from HR) ─────────────────
  { date: '2026-01-15', name: 'Pongal' },
  { date: '2026-01-16', name: 'Thiruvalluvar Day' },
  { date: '2026-01-26', name: 'Republic Day' },
  { date: '2026-04-14', name: 'Tamil New Year' },
  { date: '2026-05-01', name: 'May Day' },
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-10-02', name: 'Gandhi Jayanthi' },
  { date: '2026-10-19', name: 'Ayutha Pooja' },
  { date: '2026-10-20', name: 'Ayutha Pooja' },
  { date: '2026-11-08', name: 'Diwali' },
  { date: '2026-11-09', name: 'Diwali' },

  // ── 2027 (placeholder — HR will refresh annually) ────────────────────
  { date: '2027-01-14', name: 'Pongal' },
  { date: '2027-01-26', name: 'Republic Day' },
  { date: '2027-05-01', name: 'May Day' },
  { date: '2027-08-15', name: 'Independence Day' },
  { date: '2027-10-02', name: 'Gandhi Jayanthi' },
];

const HOLIDAY_SET = new Set(HOLIDAYS.map(h => h.date));

/** Return true if the given yyyy-mm-dd date is an HR-declared holiday. */
function isHoliday(iso) {
  return HOLIDAY_SET.has(String(iso).slice(0, 10));
}

/** Return true if the given Date or ISO date string is a Sunday. */
function isSunday(d) {
  const dt = d instanceof Date ? d : new Date(String(d) + (String(d).length === 10 ? 'T00:00:00' : ''));
  return dt.getDay() === 0;
}

/** Return true if the date should be treated as a paid non-working day. */
function isPaidOff(iso) {
  return isSunday(iso) || isHoliday(iso);
}

/** Return the HR-friendly label for a holiday, or '' if not one. */
function holidayName(iso) {
  const hit = HOLIDAYS.find(h => h.date === String(iso).slice(0, 10));
  return hit ? hit.name : '';
}

/**
 * Count working days (excluding Sundays + holidays) inclusively between
 * two ISO dates. Used by attendance summary so the "expected days" tile
 * subtracts the off days from the month total.
 */
function countWorkingDays(startIso, endIso) {
  const a = new Date(startIso + 'T00:00:00');
  const b = new Date(endIso   + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return 0;
  let n = 0;
  for (const cur = new Date(a); cur <= b; cur.setDate(cur.getDate() + 1)) {
    const iso = cur.toISOString().slice(0, 10);
    if (!isPaidOff(iso)) n++;
  }
  return n;
}

module.exports = {
  HOLIDAYS,
  HOLIDAY_SET,
  isHoliday,
  isSunday,
  isPaidOff,
  holidayName,
  countWorkingDays,
};
