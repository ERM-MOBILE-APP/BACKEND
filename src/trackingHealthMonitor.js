/**
 * trackingHealthMonitor — server-side stale-ping detector.
 *
 * Runs every 3 minutes. For each user who is checked in today, checks
 * when the last LocationPing arrived. If it's older than 5 minutes
 * (i.e. two missed 2-min ticks), logs a WARN and stamps
 * `trackingDegraded: true` + `trackingLastGapMinutes: N` on the user
 * doc so HRMS can filter for them.
 *
 * When a fresh ping arrives, the User.lastLocation update in
 * locationPing() itself clears the flag as a side effect of setting
 * presence='active' — but that only happens when the ping actually
 * makes it through. This monitor gives HR proactive visibility of
 * *stuck* sessions where pings just stop.
 *
 * #372 — added so HR can immediately spot which employees are
 * currently dropping tracking without having to eyeball the map.
 */
const Attendance   = require('./models/Attendance');
const LocationPing = require('./models/LocationPing');
const User         = require('./models/User');

const CHECK_INTERVAL_MS = 3 * 60 * 1000;   // run every 3 min
const STALE_THRESHOLD_MS = 5 * 60 * 1000;  // > 5 min silence = degraded

function todayISO() {
  const d = new Date();
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function sweepOnce() {
  const now = Date.now();
  const date = todayISO();
  const openSessions = await Attendance.find({
    date,
    checkIn:  { $ne: null },
    $or: [{ checkOut: null }, { checkOut: { $exists: false } }],
  }).select('user').lean();

  if (!openSessions.length) return { checked: 0, degraded: 0 };

  let degraded = 0;
  for (const s of openSessions) {
    try {
      const lastPing = await LocationPing.findOne({ user: s.user, date })
        .sort({ recordedAt: -1 })
        .select('recordedAt')
        .lean();
      const ageMs = lastPing
        ? now - new Date(lastPing.recordedAt).getTime()
        : now - CHECK_INTERVAL_MS;   // no pings at all → treat as very stale
      const isDegraded = ageMs > STALE_THRESHOLD_MS;
      const gapMin = Math.round(ageMs / 60000);

      await User.findByIdAndUpdate(s.user, {
        trackingDegraded:       isDegraded,
        trackingLastGapMinutes: gapMin,
        trackingHealthAt:       new Date(),
      });
      if (isDegraded) degraded++;
    } catch (e) {
      console.warn('[trackingHealth] user check failed:', e.message);
    }
  }
  if (degraded > 0) {
    console.warn(`[trackingHealth] ${degraded}/${openSessions.length} checked-in employees have degraded tracking (>5 min since last ping)`);
  }
  return { checked: openSessions.length, degraded };
}

function startTrackingHealthMonitor() {
  if (!process.env.MONGO_URI && process.env.NODE_ENV !== 'production') return;
  console.log('[trackingHealth] ✓ scheduled — every 3 min');
  const safe = async () => {
    try { await sweepOnce(); }
    catch (e) { console.warn('[trackingHealth] tick crashed:', e && e.message); }
  };
  setTimeout(safe, 30_000);
  setInterval(safe, CHECK_INTERVAL_MS);
}

module.exports = { startTrackingHealthMonitor, sweepOnce };
