/**
 * autoCloseAttendance — nightly sweeper that closes any attendance row
 * the employee forgot to check out of.
 *
 *   • Runs once at boot, then on a 10-min interval — whenever the wall
 *     clock has just crossed midnight IST it runs the close. We don't
 *     trust a single setTimeout(midnight) because Render restarts the
 *     process throughout the day and we'd miss the cutoff.
 *   • For every Attendance doc with checkIn but no checkOut on the day
 *     BEFORE today's IST date, we stamp checkOut = end-of-that-day and
 *     flip status to 'absent' — HR's rule is that an employee who
 *     forgot to clock out gets the day struck off rather than counted.
 *
 * Idempotent: the same doc on the next pass already has checkOut set,
 * so the filter excludes it.
 */
const Attendance = require('./models/Attendance');
const Notification = require('./models/Notification');

// dd-mm-yyyy formatter — same shape HRMS uses elsewhere.
function fmtDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return String(iso);
}

const IST_OFFSET_MIN = 5 * 60 + 30;   // +05:30

// Returns the IST yyyy-mm-dd for any JS Date.
function istDateStr(d) {
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

// #369 — Return yesterday 23:59:59.999 IST as a proper UTC Date object.
// The previous version stored UTC 23:59 (which the frontend then rendered
// as 05:29 AM IST because it converts back to IST at display time). We
// want the wall-clock time to read as "11:59 PM" in IST.
function lastIstMidnight() {
  const now = new Date();
  // Shift now into IST wall time.
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60 * 1000);
  // Zero the IST clock, then step back 1ms so we land on yesterday 23:59:59.999 IST.
  istNow.setUTCHours(0, 0, 0, 0);
  const yesterdayIst2359 = new Date(istNow.getTime() - 1);   // 23:59:59.999 IST
  // Convert back to UTC for Mongo storage.
  return new Date(yesterdayIst2359.getTime() - IST_OFFSET_MIN * 60 * 1000);
}

async function sweepOnce() {
  try {
    const todayIst = istDateStr(new Date());
    // Anything with checkIn set, no checkOut, and date strictly before today.
    const candidates = await Attendance.find({
      checkIn:  { $ne: null },
      $or: [{ checkOut: null }, { checkOut: { $exists: false } }],
      date:     { $lt: todayIst },
    }).limit(500);

    if (!candidates.length) return { closed: 0 };

    const closeStamp = lastIstMidnight();
    let closed = 0;
    for (const row of candidates) {
      // Belt-and-braces: skip if somehow checkOut got set between the
      // find and the save (concurrent mobile submit).
      if (row.checkOut) continue;
      row.checkOut = closeStamp;
      row.status   = 'absent';
      row.autoClosed = true;
      row.autoClosedAt = new Date();
      try {
        await row.save();
        closed++;
        // Warn the employee the next time they open the app. HR rule:
        // forgetting to check out = absent for the day, with an audit
        // trail visible in the employee's notification bell.
        try {
          await Notification.create({
            user: row.user,
            title: 'You forgot to check out',
            body:  `On ${fmtDate(row.date)} you didn't check out, so the system automatically checked you out at 12:00 AM and marked the day as Absent.`,
            type:  'attendance',
            link:  '/(tabs)/attendance',
          });
        } catch (notifyErr) {
          console.warn('[autoCloseAttendance] notify failed:', notifyErr.message);
        }
      }
      catch (e) { console.warn('[autoCloseAttendance] save failed:', e.message); }
    }
    if (closed) console.log(`[autoCloseAttendance] closed ${closed} forgotten check-in(s)`);
    return { closed };
  } catch (err) {
    console.warn('[autoCloseAttendance] sweep failed:', err.message);
    return { closed: 0, error: err.message };
  }
}

// Boot the sweeper. Hits once at startup, then every 10 minutes — that's
// frequent enough to catch the midnight rollover within a 10-min window
// and infrequent enough to not stress Mongo.
function startAutoCloseAttendance() {
  // Skip in test/no-DB environments.
  if (!process.env.MONGO_URI && process.env.NODE_ENV !== 'production') {
    return;
  }
  console.log('[autoCloseAttendance] ✓ scheduled — every 10 min');
  // Wrap each tick so a single thrown error never kills the cron loop.
  // setInterval inherits the previous error if the callback rejects; in
  // older Node this could break the timer entirely.
  const safeSweep = async () => {
    try { await sweepOnce(); }
    catch (e) { console.warn('[autoCloseAttendance] tick crashed:', e && e.message); }
  };
  setTimeout(safeSweep, 15_000);
  setInterval(safeSweep, 10 * 60 * 1000);
}

module.exports = { startAutoCloseAttendance, sweepOnce };
