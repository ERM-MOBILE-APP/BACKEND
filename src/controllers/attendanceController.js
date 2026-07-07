const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const AttendanceRequest = require('../models/AttendanceRequest');
const LocationPing = require('../models/LocationPing');
const User = require('../models/User');
const Allowance = require('../models/Allowance');
const {
  isPetrolGpsEmployee,
  PETROL_RATE_RUPEES_PER_KM,
} = require('../petrolGpsAllowlist');

const isObjId = (v) => v && typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

/**
 * Resolve a department or designation reference to a human label.
 * Some employees store the field as the raw title string, others as an
 * ObjectId pointing at the HRMS `departments` / `designations` collection
 * (same Mongo cluster). This handles both, plus the rare "string that
 * looks like an ObjectId" case.
 */
async function resolveLabel(value, kind) {
  if (value == null || value === '') return '';
  const str = typeof value === 'object' ? String(value) : String(value);
  if (!isObjId(str)) return str;
  try {
    const coll = kind === 'dept' ? 'departments' : 'designations';
    const doc  = await mongoose.connection.db
      .collection(coll)
      .findOne({ _id: new mongoose.Types.ObjectId(str) });
    return doc?.name || doc?.title || '';
  } catch {
    return '';
  }
}

const todayISO = () => new Date().toISOString().split('T')[0];

/**
 * Haversine distance in km between two lat/lng pairs. Returns 0 for
 * invalid inputs so callers can sum safely.
 */
function haversineKm(a, b) {
  if (!a || !b) return 0;
  if (typeof a.lat !== 'number' || typeof a.lng !== 'number') return 0;
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return 0;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Compact a polyline by dropping points that sit within `minStepM` metres
 * of the previously-kept point. Always keeps the first and last samples
 * so day-start / day-end markers stay accurate.
 *
 * Why this matters
 * ────────────────
 * A typical 8-hour shift produces 240+ pings (one every 2 min). When the
 * employee is stationary (at a desk, in a meeting) consecutive samples
 * differ only by GPS noise — usually < 10 m. Including all of them
 * inflates the JSON payload by 5-10x without changing the visual route
 * shape on the map at all. After simplification, a typical day's
 * polyline drops from ~30 KB to ~5-10 KB, and the modal's first paint
 * happens visibly faster.
 *
 * Returns the simplified array; safe on arrays < 2.
 */
function simplifyPolyline(points, minStepM = 10) {
  if (!Array.isArray(points) || points.length < 3) return points || [];
  const stepKm = minStepM / 1000;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    if (haversineKm(last, points[i]) >= stepKm) {
      out.push(points[i]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Build the canonical "day route" for one (user, date) — used by:
 *   • check-out, to stamp totalDistanceKm on the Attendance row
 *   • HRMS admin daily-route endpoint, to render the polyline + km
 *   • HRMS allowance map view, to show the path that justifies the
 *     petrol/travel claim
 *
 * Walks every LocationPing for the day (between checkIn and checkOut,
 * if those exist), sums haversine across consecutive pairs, and returns
 * the polyline as [{lat,lng,at}] for map rendering. Falls back to a
 * straight line between checkIn/checkOut coords when < 2 pings exist
 * (e.g. employee turned GPS off mid-shift).
 *
 * `source` tells the caller how trustworthy the number is:
 *   'gps'  — derived from ≥ 2 pings (full path)
 *   'pins' — straight line between checkIn and checkOut coords only
 *   'none' — no usable coords on the day
 */
async function buildDailyRoute(userId, dateIso, opts = {}) {
  const empty = { distanceKm: 0, source: 'none', polyline: [], from: null, to: null };
  if (!userId || !dateIso) return empty;

  // Optional time window — when computing for an Attendance row we trim
  // to the actual checkIn → checkOut span so pings from before check-in
  // (e.g. yesterday's tail) or after check-out don't inflate distance.
  const q = { user: userId, date: dateIso };
  if (opts.checkIn || opts.checkOut) {
    q.recordedAt = {};
    if (opts.checkIn)  q.recordedAt.$gte = new Date(opts.checkIn);
    if (opts.checkOut) q.recordedAt.$lte = new Date(opts.checkOut);
    if (!Object.keys(q.recordedAt).length) delete q.recordedAt;
  }

  const pings = await LocationPing.find(q)
    .sort({ recordedAt: 1 })
    .select('lat lng recordedAt')
    .lean();

  if (pings.length >= 2) {
    // Sum the FULL ping list for accurate km — every micro-movement
    // counts toward distance even if we won't render it. Then SIMPLIFY
    // before serializing the polyline to keep the response payload small.
    let total = 0;
    for (let i = 1; i < pings.length; i++) {
      total += haversineKm(pings[i - 1], pings[i]);
    }
    const first = pings[0];
    const last  = pings[pings.length - 1];
    const compact = simplifyPolyline(
      pings.map((p) => ({ lat: p.lat, lng: p.lng, at: p.recordedAt })),
      10,   // metres — dropping noise-level deltas
    );
    return {
      distanceKm: Math.round(total * 100) / 100,
      source:     'gps',
      polyline:   compact,
      from:       { lat: first.lat, lng: first.lng, at: first.recordedAt },
      to:         { lat: last.lat,  lng: last.lng,  at: last.recordedAt  },
    };
  }

  // Fallback: straight line between checkIn/checkOut coords if both exist.
  if (opts.checkInLat != null && opts.checkInLng != null &&
      opts.checkOutLat != null && opts.checkOutLng != null) {
    const a = { lat: opts.checkInLat,  lng: opts.checkInLng  };
    const b = { lat: opts.checkOutLat, lng: opts.checkOutLng };
    const km = haversineKm(a, b);
    return {
      distanceKm: Math.round(km * 100) / 100,
      source:     'pins',
      polyline:   [
        { lat: a.lat, lng: a.lng, at: opts.checkIn  || null },
        { lat: b.lat, lng: b.lng, at: opts.checkOut || null },
      ],
      from: { lat: a.lat, lng: a.lng, at: opts.checkIn  || null },
      to:   { lat: b.lat, lng: b.lng, at: opts.checkOut || null },
    };
  }
  return empty;
}

exports.buildDailyRoute = buildDailyRoute;

const monthBounds = (month, year) => {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
};

// POST /api/attendance/checkin  body: { location: 'remote' | 'office' }
//
// #336 — Now supports RESUME after an accidental (or intentional) check-out.
// If the employee already has a completed session earlier in the same
// day (i.e. record.checkOut is set), tapping Check In again does NOT
// create a fresh record and does NOT reset the working-hours timer.
// Instead:
//   • record.checkIn is stamped with the new session's start
//   • record.checkOut is cleared (signals "currently working")
//   • record.accumulatedSeconds (rolled up on the prior checkout) is
//     preserved — the client-side timer resumes from that base
//   • record.firstCheckIn stays pinned to the day's first arrival
// The completed session's {checkIn, checkOut, ...} tuple was already
// pushed into record.sessions[] by the checkout handler, so audit
// history is intact.
exports.checkIn = async (req, res) => {
  try {
    const date = todayISO();
    const { location = 'office', lat, lng, accuracy } = req.body || {};

    let record = await Attendance.findOne({ user: req.user.id, date });

    // Only block if currently in an OPEN session (checkIn set, no
    // matching checkOut). A row with both checkIn AND checkOut set is
    // a completed session and the employee is free to Resume Work.
    if (record && record.checkIn && !record.checkOut) {
      return res.status(400).json({ message: 'Already checked in today' });
    }

    // Late if check-in is past 10:01 AM IST. Anyone clocking in at
    // 10:01 or later is flagged late; the cumulative late count then
    // drives the half-day / full-day LOP rule in the leave policy calc.
    //
    // CRITICAL: the host (Render free-tier) runs in UTC. Using
    // now.getHours() returned UTC hours, so a 10:01 IST check-in showed
    // up at 04:31 UTC → 4, which is < 10, so isLate was ALWAYS false on
    // prod even though it worked on a dev machine in IST. We extract the
    // hour/minute via Intl.DateTimeFormat in Asia/Kolkata so the policy
    // applies correctly regardless of the host timezone.
    const now = new Date();
    const istParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour:   '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const istHour   = parseInt(istParts.find(p => p.type === 'hour')?.value   || '0', 10);
    const istMinute = parseInt(istParts.find(p => p.type === 'minute')?.value || '0', 10);
    // #352a — Three-tier check-in classification per HR policy (Jul 2026):
    //   ≤ 10:00                    → present  (on-time)
    //   10:01 AM – 10:30 AM        → late     (still counted present, HR sees Late flag)
    //   > 10:30 AM                 → absent   (marked absent even though they DID
    //                                          check in; employee can file an
    //                                          Attendance Regularisation request
    //                                          which, once the manager approves it,
    //                                          the adminUpdateRequest handler flips
    //                                          to 'permission'. HR can also
    //                                          manually mark 'present' via the
    //                                          adminMarkStatus endpoint.)
    //
    // Rationale: the old rule marked ANY check-in after 10:01 as Late
    // regardless of how late they were — a 4-hour delay looked the same
    // as a 2-minute one. The new rule gives HR + payroll a clean signal
    // that the late tier ends at 10:30 and anything beyond is treated as
    // an unexplained absence until the employee justifies it.
    const minutesSinceMidnight = istHour * 60 + istMinute;
    const LATE_START = 10 * 60 + 1;    // 10:01
    const LATE_END   = 10 * 60 + 30;   // 10:30
    let checkInStatus;
    if (minutesSinceMidnight < LATE_START) {
      checkInStatus = 'present';
    } else if (minutesSinceMidnight <= LATE_END) {
      checkInStatus = 'late';
    } else {
      checkInStatus = 'absent';
    }
    // Preserve legacy name for the one downstream `isLate` reference below.
    const isLate = checkInStatus === 'late';
    // #336 — on a RESUME check-in, don't overwrite the day's late/present
    // status. Late is based on the FIRST arrival only. If firstCheckIn
    // is already set, keep whatever status the day earned that morning.
    const isResume = !!(record && record.firstCheckIn);
    const status   = isResume
      ? (record.status || 'present')
      : checkInStatus;

    const checkInLat = (typeof lat === 'number' && isFinite(lat)) ? lat : null;
    const checkInLng = (typeof lng === 'number' && isFinite(lng)) ? lng : null;

    if (!record) {
      // First check-in of the day → fresh row, zeroed timers.
      record = await Attendance.create({
        user: req.user.id,
        date,
        checkIn: now,
        firstCheckIn: now,          // #336 snapshot for reports
        location,
        status,
        checkInLat, checkInLng,
        autoCheckedOut: false,
        accumulatedSeconds: 0,
        sessions: [],
      });
    } else {
      // Existing row — either a first check-in on a pre-created shell
      // OR a #336 Resume (record.checkOut was set). Either way:
      //   • Stamp the new session's start on record.checkIn
      //   • Clear record.checkOut (signals "working")
      //   • Preserve accumulatedSeconds and sessions[] — the completed
      //     sessions and their duration are already rolled up
      record.checkIn  = now;
      record.checkOut = null;                       // #336 reopen — "working"
      if (!record.firstCheckIn) record.firstCheckIn = now;
      record.location = location;
      record.status   = status;
      record.checkInLat = checkInLat;
      record.checkInLng = checkInLng;
      // Don't stamp checkOut coords on the row here — those belong to
      // the last completed session and live inside sessions[].
      record.checkOutLat = null;
      record.checkOutLng = null;
      record.autoCheckedOut  = false;
      // earlyCheckoutLop is stamped at checkout — resuming clears the
      // flag; if they check out early again the checkout handler will
      // re-evaluate and restamp based on the new checkout time.
      record.earlyCheckoutLop = false;
      await record.save();
    }

    // Bring the user's live presence up to date and store the first ping.
    if (checkInLat != null && checkInLng != null) {
      await User.findByIdAndUpdate(req.user.id, {
        presence: 'active',
        lastSeenAt: now,
        lastLocation: { lat: checkInLat, lng: checkInLng, accuracy: accuracy ?? null, updatedAt: now },
      });
      try {
        await LocationPing.create({
          user: req.user.id,
          date,
          recordedAt: now,
          lat: checkInLat, lng: checkInLng,
          accuracy: typeof accuracy === 'number' ? accuracy : null,
          presence: 'active',
        });
      } catch (e) { console.warn('[checkIn] initial ping save failed:', e.message); }
    }

    res.json({ message: 'Checked in', record });
  } catch (err) {
    console.error('checkIn error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/attendance/checkout  body (optional): { lat, lng, accuracy }
//
// lat/lng are best-effort — the user may have GPS off at checkout time
// (they're leaving the office, opening Maps, etc.), and we don't want to
// trap them in a checked-in state. When supplied we record the spot;
// when not, the checkout still succeeds with the time stamp only.
exports.checkOut = async (req, res) => {
  try {
    const date = todayISO();
    const { lat, lng, accuracy } = req.body || {};
    const record = await Attendance.findOne({ user: req.user.id, date });
    if (!record || !record.checkIn) {
      return res.status(400).json({ message: 'You must check in first' });
    }
    if (record.checkOut) {
      return res.status(400).json({ message: 'Already checked out today' });
    }
    const now = new Date();
    record.checkOut = now;
    // ─── #336 Roll up session into accumulated total ────────────────
    // Compute THIS session's duration (checkIn → now), add it into the
    // running accumulatedSeconds, then derive workedHours from the
    // accumulated total. Also push the completed pair into sessions[]
    // so HR audit reports can list every in/out cycle for the day.
    const sessionSeconds = Math.max(
      0,
      Math.round((now.getTime() - new Date(record.checkIn).getTime()) / 1000),
    );
    record.accumulatedSeconds = Math.max(0, (record.accumulatedSeconds || 0) + sessionSeconds);
    // workedHours = TOTAL of all sessions today (not just this one).
    // Keeps HRMS reports / Payroll compatible without any changes.
    record.workedHours =
      Math.round((record.accumulatedSeconds / 3600) * 100) / 100;
    // Coordinates for THIS session's checkout land on the row (they
    // represent the last known location) AND inside the session record.
    const _checkOutLatForSession = (typeof lat === 'number' && isFinite(lat)) ? lat : null;
    const _checkOutLngForSession = (typeof lng === 'number' && isFinite(lng)) ? lng : null;
    if (!Array.isArray(record.sessions)) record.sessions = [];
    record.sessions.push({
      checkIn:  record.checkIn,
      checkOut: now,
      checkInLat:  record.checkInLat  ?? null,
      checkInLng:  record.checkInLng  ?? null,
      checkOutLat: _checkOutLatForSession,
      checkOutLng: _checkOutLngForSession,
      durationSeconds: sessionSeconds,
    });

    // ─── Halfday policy (#352b — Jul 2026 HR rule, final) ────────────
    // Rule: hours-only, no time-of-day gate.
    //   • Worked <  5 h → halfday (or permission if a permission
    //                     request is on file for the day)
    //   • Worked ≥  5 h → keep existing status (present / late)
    //
    // The check-out timestamp is NOT consulted. An employee who
    // arrives at 7 AM and leaves at 12 PM has clocked 5 hours and
    // gets full-day credit. An employee who clocks 4 hours regardless
    // of when they arrived/left gets halfday.
    //
    // Worked-hours read from the running total. In the multi-session
    // schema this is `accumulatedSeconds`; on legacy rows we fall back
    // to `workedHours` which the checkout handler set just above.
    const HALFDAY_THRESHOLD_HOURS = 5;
    const workedHoursForPolicy =
      typeof record.accumulatedSeconds === 'number' && record.accumulatedSeconds > 0
        ? record.accumulatedSeconds / 3600
        : Number(record.workedHours || 0);
    const isHalfDay = workedHoursForPolicy < HALFDAY_THRESHOLD_HOURS;

    if (isHalfDay) {
      let hasPermissionRequest = false;
      try {
        const perm = await Leave.findOne({
          user: req.user.id,
          requestType: 'permission',
          date,
          status: { $in: ['pending', 'approved'] }, // any non-rejected request
        }).lean();
        hasPermissionRequest = !!perm;
      } catch { /* fall through and treat as no permission */ }

      if (hasPermissionRequest) {
        // Permission filed (any non-rejected state) — show as Permission.
        record.status = 'permission';
        record.earlyCheckoutLop = false;
      } else {
        // No permission filed → half-day LOP.
        record.status = 'halfday';
        record.earlyCheckoutLop = true;
      }
    } else {
      // EITHER checked out at/after 5:30 PM OR worked ≥ 5 h — full-day
      // credit. Keep the existing status (e.g. 'late' from morning
      // arrival) and clear any stale LOP flag.
      record.earlyCheckoutLop = false;
    }


    const checkOutLat = (typeof lat === 'number' && isFinite(lat)) ? lat : null;
    const checkOutLng = (typeof lng === 'number' && isFinite(lng)) ? lng : null;
    if (checkOutLat != null && checkOutLng != null) {
      record.checkOutLat = checkOutLat;
      record.checkOutLng = checkOutLng;
    }

    // Stamp the day's total travel distance + source on the Attendance
    // row. This is what HR sees in the petrol section for *every*
    // employee — including those who didn't submit a travel/petrol
    // allowance request. The polyline isn't stored (would bloat the
    // row); HR can re-fetch it from LocationPings on demand via the
    // /admin/daily-route endpoint.
    let dayRoute = null;
    try {
      dayRoute = await buildDailyRoute(req.user.id, date, {
        checkIn:     record.checkIn,
        checkOut:    now,
        checkInLat:  record.checkInLat,
        checkInLng:  record.checkInLng,
        checkOutLat,
        checkOutLng,
      });
      record.totalDistanceKm = dayRoute.distanceKm;
      record.distanceSource  = dayRoute.source;
    } catch (e) {
      console.warn('[checkOut] distance compute failed:', e.message);
    }

    await record.save();

    // ─── Auto petrol-allowance request on check-out (Jun 2026) ────────
    // Hardened Jun 2026 — earlier version silently skipped when
    // dayRoute.distanceKm was 0 (which happens whenever GPS pings
    // are missing or checkout lat/lng weren't sent), so PETROL TEST
    // saw no row appear even though he was eligible. Now:
    //   • Every decision branch logs a prefixed line so ops can see
    //     in Render logs why a row was / wasn't created.
    //   • Distance falls back through three sources in order:
    //     dayRoute.distanceKm → record.totalDistanceKm → straight-line
    //     between checkIn and checkOut coords → 0.
    //   • A row is created EVEN when distance is 0, as long as the
    //     employee is petrolEligible. HR can review/reject; better
    //     than a silent no-op.
    //   • The catch logs the full stack instead of just .message.
    const LOG = '[petrol-autobill]';
    try {
      // Read via the User model first (gives us name/dept/firstName), but
      // ALSO read the raw document directly from the employees collection
      // so we get the petrolEligible value even if Mongoose's strict mode
      // or schema caching is stripping it on hydration. Whichever source
      // reports the field, we use it.
      const userDoc = await User.findById(req.user.id)
        .select('petrolEligible firstName lastName name userId email department departmentName')
        .lean();
      let rawDoc = null;
      try {
        rawDoc = await mongoose.connection.db
          .collection('employees')
          .findOne({ _id: new mongoose.Types.ObjectId(String(req.user.id)) });
      } catch (rawErr) {
        console.warn(`${LOG} raw collection read failed:`, rawErr.message);
      }

      // Merge: prefer raw collection value for petrolEligible (most
      // authoritative — bypasses Mongoose schema), prefer userDoc for
      // name fields (already projected and cleaned).
      const merged = {
        ...(userDoc || {}),
        ...(rawDoc && typeof rawDoc.petrolEligible === 'boolean'
            ? { petrolEligible: rawDoc.petrolEligible }
            : {}),
      };

      const userTag = merged ? `${merged.userId || merged.email || merged._id || req.user.id}` : 'unknown';
      if (!userDoc && !rawDoc) {
        console.warn(`${LOG} skip: no user record for ${req.user.id}`);
      } else {
        const eligible = isPetrolGpsEmployee(merged);
        console.log(`${LOG} user=${userTag} petrolEligible(User)=${userDoc && userDoc.petrolEligible} petrolEligible(raw)=${rawDoc && rawDoc.petrolEligible} resolved=${eligible}`);

        if (!eligible) {
          console.log(`${LOG} skip ${userTag}: not eligible (flag=${merged.petrolEligible}, dept=${merged.department || merged.departmentName}, name=${merged.name || merged.firstName || ''})`);
        } else {
          const already = await Allowance.findOne({
            user: req.user.id,
            date,
            type: 'petrol',
          }).select('_id').lean();

          if (already) {
            console.log(`${LOG} skip ${userTag}: row already exists (_id=${already._id})`);
          } else {
            // Resolve distance through cascading fallbacks. Whichever
            // source produces > 0 wins. If they all return 0 we STILL
            // create the row (with distance 0) so HR sees it and can
            // act — better than a silent skip.
            let km        = 0;
            let source    = 'none';
            let fromLat   = null, fromLng = null, toLat = null, toLng = null;
            let fromTime  = null, toTime  = null;

            if (dayRoute && Number(dayRoute.distanceKm) > 0) {
              km     = Number(dayRoute.distanceKm);
              source = dayRoute.source || 'gps';
              if (dayRoute.from) { fromLat = dayRoute.from.lat; fromLng = dayRoute.from.lng; fromTime = dayRoute.from.at; }
              if (dayRoute.to)   { toLat   = dayRoute.to.lat;   toLng   = dayRoute.to.lng;   toTime   = dayRoute.to.at;   }
            } else if (Number(record.totalDistanceKm) > 0) {
              km     = Number(record.totalDistanceKm);
              source = record.distanceSource || 'attendance';
              fromLat = record.checkInLat ?? null;
              fromLng = record.checkInLng ?? null;
              toLat   = record.checkOutLat ?? null;
              toLng   = record.checkOutLng ?? null;
            } else if (
              record.checkInLat != null && record.checkInLng != null &&
              record.checkOutLat != null && record.checkOutLng != null
            ) {
              // Straight-line haversine between check-in pin + check-out pin.
              const a = { lat: record.checkInLat,  lng: record.checkInLng };
              const b = { lat: record.checkOutLat, lng: record.checkOutLng };
              km     = Math.round(haversineKm(a, b) * 100) / 100;
              source = 'pins';
              fromLat = a.lat; fromLng = a.lng; toLat = b.lat; toLng = b.lng;
            } else {
              source = 'none';
              console.warn(`${LOG} ${userTag}: distance computed as 0 (no GPS pings, no totalDistanceKm, no check-in/out coords).`);
            }

            const amount = Math.round(km * PETROL_RATE_RUPEES_PER_KM * 100) / 100;
            const fmt    = (n) => (typeof n === 'number' && isFinite(n)) ? n.toFixed(5) : '—';
            const fromLoc = (fromLat != null && fromLng != null)
              ? `Check-in (${fmt(fromLat)}, ${fmt(fromLng)})`
              : 'Check-in';
            const toLoc = (toLat != null && toLng != null)
              ? `Check-out (${fmt(toLat)}, ${fmt(toLng)})`
              : 'Check-out';

            // Distinguish gps-confirmed rows from approximate ones in
            // the notes so HR knows what they're acting on.
            const note =
              source === 'gps'
                ? `Auto-generated on check-out. GPS distance ${km.toFixed(2)} km × ₹${PETROL_RATE_RUPEES_PER_KM}/km.`
                : source === 'pins'
                  ? `Auto-generated on check-out. Straight-line distance ${km.toFixed(2)} km between check-in and check-out (no GPS trail) × ₹${PETROL_RATE_RUPEES_PER_KM}/km.`
                  : source === 'attendance'
                    ? `Auto-generated on check-out. Distance ${km.toFixed(2)} km from attendance totalDistanceKm × ₹${PETROL_RATE_RUPEES_PER_KM}/km.`
                    : `Auto-generated on check-out. No GPS distance recorded today — HR may reject.`;

            const newDoc = await Allowance.create({
              user:           req.user.id,
              type:           'petrol',
              purpose:        'Daily field work (auto-billed from GPS)',
              fromLocation:   fromLoc,
              toLocation:     toLoc,
              date,
              transport:      'Bike',
              distance:       km,
              distanceSource: source === 'gps' || source === 'pins' ? 'gps' : 'manual',
              fromLat,
              fromLng,
              toLat,
              toLng,
              amount,
              typedAmount:    amount,
              notes:          note,
              managerStatus:  '',
              status:         'pending',
            });
            console.log(`${LOG} OK ${userTag}: created _id=${newDoc._id} distance=${km} km source=${source} amount=₹${amount}`);
          }
        }
      }
    } catch (e) {
      // Non-fatal — checkout itself succeeded; HR can still file the
      // claim manually if this cron misfires. Log the full stack so
      // ops can see exactly where it broke instead of just .message.
      console.error(`${LOG} ERROR for user ${req.user.id}:`, e);
    }

    // Mark the user offline + drop a final LocationPing at the checkout
    // coords (if available). The HRMS Live Tracking page uses this last
    // ping to fade them from "active" to "checked out".
    try {
      const userUpdate = { presence: 'offline', lastSeenAt: now };
      if (checkOutLat != null && checkOutLng != null) {
        userUpdate.lastLocation = {
          lat: checkOutLat,
          lng: checkOutLng,
          accuracy: typeof accuracy === 'number' ? accuracy : null,
          updatedAt: now,
        };
      }
      await User.findByIdAndUpdate(req.user.id, userUpdate);
      if (checkOutLat != null && checkOutLng != null) {
        await LocationPing.create({
          user: req.user.id,
          date,
          recordedAt: now,
          lat: checkOutLat,
          lng: checkOutLng,
          accuracy: typeof accuracy === 'number' ? accuracy : null,
          presence: 'offline',
        });
      }
    } catch (e) {
      // Non-fatal — the attendance row is what matters; presence is best-effort.
      console.warn('[checkOut] presence/ping update failed:', e.message);
    }

    res.json({ message: 'Checked out', record });
  } catch (err) {
    console.error('checkOut error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/today
//
// #336 — response now carries the multi-session shape so the frontend
// timer can resume across page reloads / app restarts:
//   • firstCheckIn        — the day's very first arrival (for display)
//   • accumulatedSeconds  — total time from all COMPLETED sessions
//   • sessions[]          — chronological history of completed sessions
//   • isOnBreak           — true when the employee has checked out at
//                           least once today but the workday isn't
//                           "done"; the frontend uses this to swap the
//                           button label from "Check In" → "Resume Work"
exports.getToday = async (req, res) => {
  try {
    const date = todayISO();
    const record = await Attendance.findOne({ user: req.user.id, date }).lean();

    if (!record) {
      return res.json({
        date,
        shiftName: 'General Shift',
        checkIn: null,
        checkOut: null,
        firstCheckIn: null,
        location: '',
        workedHours: 0,
        accumulatedSeconds: 0,
        sessions: [],
        isOnBreak: false,
        status: 'absent',
      });
    }

    // Live workedHours: while a session is open, include the running
    // in-progress seconds so the top card and HRMS live views tick
    // upward. When on break, only show the accumulated total.
    const accumulated = Number(record.accumulatedSeconds || 0);
    const isWorking = !!(record.checkIn && !record.checkOut);
    let liveSeconds = accumulated;
    if (isWorking) {
      const runningSec = Math.max(
        0,
        Math.round((Date.now() - new Date(record.checkIn).getTime()) / 1000),
      );
      liveSeconds = accumulated + runningSec;
    }
    const workedHours = Math.round((liveSeconds / 3600) * 100) / 100;

    // isOnBreak — employee finished a session but hasn't started a new
    // one yet. Only true within the same working day (checkOut set and
    // no new checkIn after it). If it's a fresh row with just a first
    // arrival, they're either working or haven't started; not on break.
    const isOnBreak = !!(record.checkOut && !isWorking && record.firstCheckIn);

    res.json({
      date: record.date,
      shiftName: record.shift || 'General Shift',
      checkIn:  record.checkIn,
      checkOut: record.checkOut,
      firstCheckIn: record.firstCheckIn || record.checkIn || null,
      location: record.location,
      workedHours,
      accumulatedSeconds: accumulated,
      liveSeconds,                     // convenient for clients that want it precomputed
      sessions: Array.isArray(record.sessions) ? record.sessions : [],
      isOnBreak,
      status: record.status,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/monthly?month=&year=
// Returns date+status map (used by older calendar)
exports.getMonthly = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const { start, end } = monthBounds(month, year);

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    });

    const leaves = await Leave.find({ user: req.user.id });
    const overlay = {};
    leaves.forEach((l) => {
      if (l.requestType === 'permission' && l.date) overlay[l.date] = 'permission';
      if (l.requestType === 'leave' && l.startDate && l.endDate) {
        const d = parseAnyDate(l.startDate);
        if (d) {
          const key = d.toISOString().split('T')[0];
          if (key >= start && key <= end) overlay[key] = 'leave';
        }
      }
    });

    const map = {};
    records.forEach((r) => (map[r.date] = r.status));
    Object.entries(overlay).forEach(([k, v]) => (map[k] = v));

    const result = Object.entries(map).map(([date, status]) => ({ date, status }));
    res.json(result);
  } catch (err) {
    console.error('getMonthly error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/calendar?month=&year=
// Same as monthly but always returns the full attendance shape for the day
exports.getCalendar = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const { start, end } = monthBounds(month, year);

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    }).lean();

    res.json(
      records.map((r) => ({
        date: r.date,
        status: r.status,
        // #342 Multi-session: show day's first arrival on calendar
        // click, not the latest resume. Fallback keeps pre-upgrade rows
        // rendering unchanged.
        checkIn: r.firstCheckIn || r.checkIn,
        firstCheckIn: r.firstCheckIn || r.checkIn,
        checkOut: r.checkOut,
        workedHours: r.workedHours,
        accumulatedSeconds: Number(r.accumulatedSeconds || 0),
        sessionCount: Array.isArray(r.sessions) ? r.sessions.length : 0,
      }))
    );
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/summary?month=&year=
// Indian govt holidays (2026 default — extend per year). YYYY-MM-DD form.
// Overridable via the HOLIDAYS env var (comma-separated ISO dates) so HR
// can adjust without redeploy.
const DEFAULT_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-14', // Pongal
  '2026-01-15', // Thiruvalluvar Day
  '2026-01-26', // Republic Day
  '2026-03-14', // Holi
  '2026-04-02', // Ram Navami
  '2026-04-14', // Tamil New Year / Ambedkar Jayanti
  '2026-05-01', // Labour Day
  '2026-08-15', // Independence Day
  '2026-10-02', // Gandhi Jayanti
  '2026-10-20', // Diwali
  '2026-11-04', // Bhai Dooj
  '2026-12-25', // Christmas
];
const HOLIDAYS = new Set(
  (process.env.HOLIDAYS
    ? process.env.HOLIDAYS.split(',')
    : DEFAULT_HOLIDAYS_2026
  ).map((s) => String(s).trim())
);
const isHolidayISO = (iso) => HOLIDAYS.has(iso);

// Counts: present, absent, late, permission, halfday, leave
exports.getSummary = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const { start, end } = monthBounds(month, year);

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    }).lean();

    const summary = {
      present: 0,
      absent: 0,
      late: 0,
      permission: 0,
      halfday: 0,
      leave: 0,
      holiday: 0,         // Sundays + listed govt holidays elapsed this month
      totalDays: records.length,
    };
    records.forEach((r) => {
      if (summary[r.status] !== undefined) summary[r.status] += 1;
    });

    // Walk the month: classify each day as workday / weekly-off / holiday.
    // Sundays and govt holidays roll into the Present bucket (HR's rule —
    // employees aren't penalised for non-working days). Saturdays remain
    // standard workdays unless they appear in the HOLIDAYS list.
    const lastDay = parseInt(end.split('-')[2], 10);
    const today = new Date();
    const isCurrentMonth =
      today.getFullYear() === year && today.getMonth() + 1 === month;
    const upTo = isCurrentMonth ? today.getDate() : lastDay;
    let workdays = 0;
    let holidayBonus = 0;
    for (let d = 1; d <= upTo; d++) {
      const dt   = new Date(year, month - 1, d);
      const dow  = dt.getDay();        // 0 = Sun, 6 = Sat
      const iso  = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (dow === 0 || isHolidayISO(iso)) {
        holidayBonus += 1;
      } else {
        workdays += 1;
      }
    }
    summary.holiday          = holidayBonus;
    summary.present         += holidayBonus;     // count holidays as present
    summary.workdaysElapsed  = workdays;
    summary.absent = Math.max(
      0,
      workdays - (
        // subtract holidayBonus back out so we don't double-count it
        (summary.present - holidayBonus) +
        summary.late + summary.halfday + summary.permission + summary.leave
      )
    );

    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/history?month=&year=
// Daily history list for the month
//
// #342 — Now includes multi-session fields so ERM Mobile / Web history
// cards render the day's FIRST arrival for Check In (not the latest
// resume) and the sum of all sessions for Work Hours.
exports.getHistory = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const { start, end } = monthBounds(month, year);

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    })
      .sort({ date: -1 })
      .lean();

    res.json(
      records.map((r) => ({
        _id: r._id,
        date: r.date,
        status: r.status,
        // #342 — expose firstCheckIn so the client can display the
        // day's first arrival. Fallback to checkIn for rows created
        // before the multi-session upgrade.
        checkIn: r.firstCheckIn || r.checkIn,
        firstCheckIn: r.firstCheckIn || r.checkIn,
        // checkOut = last session end for the day.
        checkOut: r.checkOut,
        // workedHours reflects accumulatedSeconds / 3600 (multi-session sum).
        workedHours: r.workedHours,
        accumulatedSeconds: Number(r.accumulatedSeconds || 0),
        sessionCount: Array.isArray(r.sessions) ? r.sessions.length : 0,
        location: r.location,
        shift: r.shift || 'General Shift',
      }))
    );
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/attendance/request
// body: { date, requestType?, reason?, expectedCheckIn?, expectedCheckOut? }
exports.createRequest = async (req, res) => {
  try {
    const { date, requestType, reason, expectedCheckIn, expectedCheckOut } =
      req.body || {};
    if (!date) {
      return res.status(400).json({ message: 'date is required' });
    }
    const reqDoc = await AttendanceRequest.create({
      user: req.user.id,
      date,
      requestType: requestType || 'regularize',
      reason: reason || '',
      expectedCheckIn: expectedCheckIn || '',
      expectedCheckOut: expectedCheckOut || '',
    });
    res.status(201).json(reqDoc);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Auto-expire pending attendance requests older than 2 days. Runs on
// every list call (cheap: indexed query, updateMany once) so HR doesn't
// see a request that's effectively been ignored — and the employee can
// re-file because the row is no longer "pending".
async function closeStaleAttendanceRequests(filter = {}) {
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  try {
    await AttendanceRequest.updateMany(
      { ...filter, status: 'pending', createdAt: { $lt: cutoff } },
      { $set: { status: 'expired' } }
    );
  } catch (e) {
    // Sweep failure is non-fatal — the list still returns, just with
    // stale rows still marked pending. Log and move on.
    console.warn('[attendance.request] sweep failed:', e.message);
  }
}

// GET /api/attendance/requests
exports.listRequests = async (req, res) => {
  try {
    await closeStaleAttendanceRequests({ user: req.user.id });
    const items = await AttendanceRequest.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ─── Admin: list ALL attendance requests across users ─────────────────
//
// GET /api/attendance/admin/requests?status=pending|approved|rejected|expired&limit=
// Auth: x-admin-secret header (HRMS proxy uses this).
//
// HR wanted a single endpoint to see every employee's regularisation
// request without paging through each employee individually. The list
// is enriched with the requester's name + employee id sidecar so the
// HRMS UI can render rows without a second lookup.
exports.adminListRequests = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });
  try {
    await closeStaleAttendanceRequests({});
    const filter = {};
    const status = String(req.query.status || '').toLowerCase();
    if (['pending', 'approved', 'rejected', 'expired'].includes(status)) {
      filter.status = status;
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const items = await AttendanceRequest.find(filter)
      .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ items });
  } catch (err) {
    console.error('[attendance.adminListRequests]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// PATCH /api/attendance/admin/requests/:id   { status, hrComment?, reviewedBy? }
//
// HR (via HRMS) or the employee's manager (via ERM Web) updates the
// status. Fires a Notification on the row so the employee's bell badge
// updates in real time.
exports.adminUpdateRequest = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });
  try {
    const { status, hrComment, reviewedBy } = req.body || {};
    if (!['approved', 'rejected', 'pending'].includes(String(status || '').toLowerCase())) {
      return res.status(400).json({ message: 'status must be approved, rejected, or pending' });
    }
    const update = {
      status: String(status).toLowerCase(),
      reviewedAt: new Date(),
    };
    if (typeof hrComment === 'string')  update.hrComment  = hrComment;
    if (typeof reviewedBy === 'string') update.reviewedBy = reviewedBy;
    const fresh = await AttendanceRequest.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('user', 'firstName lastName name employeeId email');
    if (!fresh) return res.status(404).json({ message: 'Request not found' });

    // ─── #352c — Sync approved late-check-in requests to Permission ─────
    // Per the Jul 2026 HR policy: if an employee's Attendance row for
    // this date is 'absent' (because they checked in after 10:30 AM) and
    // a manager (or HR) has now APPROVED their attendance-regularisation
    // request, flip the day's status to 'permission' automatically.
    // This is what closes the loop between the "late check-in → Absent"
    // rule in checkIn() and the employee's ability to justify it.
    //
    // We intentionally only touch Absent rows here — if the day was
    // 'present' or 'late', an approved request means HR is fine with
    // the arrival window but the row itself is already correct.
    if (update.status === 'approved') {
      try {
        const attendanceRow = await Attendance.findOne({
          user: fresh.user?._id || fresh.user,
          date: fresh.date,
        });
        if (attendanceRow && attendanceRow.status === 'absent') {
          attendanceRow.status = 'permission';
          await attendanceRow.save();
          console.log(`[attendance.adminUpdateRequest] Absent → Permission for user=${fresh.user?.employeeId || fresh.user} date=${fresh.date}`);
        }
      } catch (syncErr) {
        // Non-fatal: the request approval itself succeeded. If the
        // attendance row didn't flip, HR can still use the manual
        // markStatus endpoint to fix it.
        console.warn('[attendance.adminUpdateRequest] status sync failed:', syncErr.message);
      }
    }

    // Notify the employee so the bell updates. Attribution defaults to
    // "by HR" because this endpoint is what HRMS hits; the body
    // distinguishes the HR final call from the manager's earlier
    // decision (the manager's notification fires from ERM Web's
    // manager.actAttendanceRequest path with its own copy).
    try {
      const { notify } = require('../utils/notify');
      const verb = update.status === 'approved' ? 'approved' :
                   update.status === 'rejected' ? 'rejected' : 'pending';
      const by = reviewedBy && /manager/i.test(reviewedBy) ? 'your manager' : 'HR';
      await notify(fresh.user?._id || fresh.user, {
        title: `Attendance request ${verb} by ${by}`,
        body:  `Your attendance regularisation for ${fresh.date} was ${verb} by ${by}` +
               (hrComment ? `. Note: "${hrComment}"` : '.'),
        type:  'attendance',
        link:  '/(tabs)/attendance',
      });
    } catch (notifyErr) {
      console.warn('[attendance.adminUpdateRequest] notify failed:', notifyErr.message);
    }
    res.json({ item: fresh });
  } catch (err) {
    console.error('[attendance.adminUpdateRequest]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// PATCH /api/attendance/mark   (existing — manual status override)
exports.markStatus = async (req, res) => {
  try {
    const { date, status } = req.body;
    if (
      !date ||
      !['present', 'leave', 'permission', 'absent', 'late', 'halfday'].includes(status)
    ) {
      return res.status(400).json({ message: 'Invalid input' });
    }
    const record = await Attendance.findOneAndUpdate(
      { user: req.user.id, date },
      { $set: { status } },
      { upsert: true, new: true }
    );
    res.json(record);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// #352d — PATCH /api/attendance/admin/mark-status  (x-admin-secret)
//
// HR-only endpoint. Lets HR override the derived status on any
// attendance row — the common case is flipping Absent (late check-in
// after 10:30 AM) to Present after a regularisation conversation.
//
// Body: { userId, employeeId, date, status, note? }
//   • userId OR employeeId — locate the target attendance row.
//   • date                 — YYYY-MM-DD.
//   • status               — one of the allowed enum values.
//   • note                 — optional HR comment stored on the row.
//
// Response: { success: true, item: <fresh Attendance row> } on success.
// No auto-create: if the row doesn't exist, returns 404 (HR should
// create it via the normal check-in/regularisation flow first).
exports.adminMarkStatus = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected)        return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  try {
    const { userId, employeeId, date, status, note } = req.body || {};
    if (!date)   return res.status(400).json({ message: 'date is required (YYYY-MM-DD)' });
    if (!status) return res.status(400).json({ message: 'status is required' });
    if (!['present', 'leave', 'permission', 'absent', 'late', 'halfday'].includes(status)) {
      return res.status(400).json({
        message: 'status must be one of: present, leave, permission, absent, late, halfday',
      });
    }

    // Resolve the user reference. Prefer explicit userId; fall back to
    // employeeId lookup so HR can post from a UI that only has the
    // human id ("TES047") on hand.
    let userRef = null;
    if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
      userRef = userId;
    } else if (employeeId) {
      const u = await User
        .findOne({ employeeId: String(employeeId).trim().toUpperCase() })
        .select('_id')
        .lean();
      if (!u) return res.status(404).json({ message: `Employee ${employeeId} not found` });
      userRef = u._id;
    } else {
      return res.status(400).json({ message: 'userId or employeeId is required' });
    }

    const record = await Attendance.findOne({ user: userRef, date });
    if (!record) return res.status(404).json({ message: `No attendance row for ${date}` });

    const previous = record.status;
    record.status = status;
    // When we flip AWAY from halfday/absent, clear the LOP flag so the
    // leavePolicy tallies get updated correctly on next read.
    if (status !== 'halfday' && status !== 'absent') {
      record.earlyCheckoutLop = false;
    }
    await record.save();

    // Best-effort notify the employee so their ERM bell reflects it.
    try {
      const { notify } = require('../utils/notify');
      await notify(userRef, {
        title: `Attendance updated by HR`,
        body:  `Your ${date} attendance was changed from ${previous} to ${status} by HR` +
               (note ? `. Note: "${note}"` : '.'),
        type:  'attendance',
        link:  '/(tabs)/attendance',
      });
    } catch (e) {
      console.warn('[attendance.adminMarkStatus] notify failed:', e.message);
    }

    res.json({ success: true, item: record });
  } catch (err) {
    console.error('[attendance.adminMarkStatus]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

function parseAnyDate(s) {
  if (!s) return null;
  const d1 = new Date(s);
  if (!isNaN(d1.getTime())) return d1;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// PRESENCE + LIVE LOCATION TRACKING
// ════════════════════════════════════════════════════════════════════════

/**
 * POST /api/attendance/location-ping     (JWT)
 * Body: { lat, lng, accuracy?, speed? }
 *
 * Fired by the mobile app every ~2 minutes while the user is checked in.
 * Updates user.lastLocation + presence=active, appends a row to the
 * LocationPing collection so HR can audit movement.
 */
exports.locationPing = async (req, res) => {
  try {
    const { lat, lng, accuracy, speed, recordedAt, isStationary } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
      return res.status(400).json({ message: 'Provide numeric lat and lng.' });
    }

    // Accuracy gate (tightened Jun 2026 — anti-jitter).
    // Mobile-side filter already rejects > 30m, so anything wider here
    // is suspect. Accept up to 50m as a safety margin (cached fallback
    // positions sometimes have a slightly looser radius). Anything
    // wider gets the live presence updated but NOT polylined.
    const accNum = typeof accuracy === 'number' ? accuracy : null;
    // #310 — Tightened from 50m → 35m to match the mobile anti-jitter
    // filter (services/locationTask.ts ACCURACY_GATE_M = 30m, plus a
    // 5m headroom for timestamp skew between the device clock and the
    // server timestamp the filter uses). Before this change the backend
    // accepted fixes the mobile filter would never even have sent,
    // because the mobile WAS sending pre-filtered fixes but a manual
    // checkin/checkout could still slip through at 50m. Now both ends
    // gate at the same effective radius — every point that lands in
    // the audit polyline is GPS-grade.
    const acceptableAccuracy = accNum == null || accNum <= 35;
    // isStationary flag from the mobile anti-jitter filter. When true,
    // the mobile sent the held anchor (not a fresh GPS reading) so the
    // polyline shouldn't be extended with what is effectively the same
    // point we already have.
    const stationary = isStationary === true;

    // Replay support (Jun 2026 — offline queue).
    // The mobile app can post `recordedAt` (ISO string) when replaying
    // a sample collected during a network outage. We trust it within a
    // reasonable window (last 6 hours; older replays are treated as
    // arriving now so a clock-skew bug can't backfill yesterday's row).
    const nowDate = new Date();
    let stampedAt = nowDate;
    if (typeof recordedAt === 'string') {
      const r = new Date(recordedAt);
      if (!isNaN(r.getTime()) && (nowDate.getTime() - r.getTime()) <= 6 * 60 * 60 * 1000 && r.getTime() <= nowDate.getTime() + 60_000) {
        stampedAt = r;
      }
    }
    const now  = stampedAt;
    const date = todayISO();

    // 1) Update the user's live presence + location (even for low-acc
    //    pings — see comment above). The `stationary` flag is mirrored
    //    onto the user doc so HRMS Live Tracking can show a clear
    //    Moving / Stationary badge per employee.
    await User.findByIdAndUpdate(req.user.id, {
      presence: 'active',
      lastSeenAt: now,
      lastLocation: {
        lat, lng,
        accuracy: accNum,
        updatedAt: now,
        stationary,
      },
    });

    // 2) Append the audit ping — gated on accuracy AND on movement.
    //    - Sub-quality samples (>50 m) never enter the polyline.
    //    - Stationary samples (anchor echoes) update presence + the
    //      "last seen" position on the user, but don't pollute the
    //      polyline. This is what makes the marker stop drifting on
    //      HR's map when an employee is standing still.
    if (!acceptableAccuracy) {
      return res.json({ ok: true, accepted: false, reason: 'accuracy>50m' });
    }
    if (stationary) {
      return res.json({ ok: true, accepted: true, stationary: true });
    }

    // #373 — DEDUPE WINDOW: 100 seconds.
    // Target cadence is 1 ping every 120 s (mobile OS task interval).
    // Anything arriving < 100 s after the previous accepted row is
    // treated as a burst / duplicate / replay — presence + lastLocation
    // are still updated (freshness clock stays current) but the audit
    // row insert is skipped. The 20-s safety margin below 120 s covers
    // normal OS delivery jitter without dropping a real scheduled tick.
    const lastPing = await LocationPing
      .findOne({ user: req.user.id, date })
      .sort({ recordedAt: -1 })
      .select('recordedAt')
      .lean();
    if (lastPing) {
      const gapSec = (now.getTime() - new Date(lastPing.recordedAt).getTime()) / 1000;
      if (gapSec < 100) {
        return res.json({
          ok: true,
          accepted: false,
          reason: 'duplicate-within-100s',
          lastPingAgeSec: Math.round(gapSec),
        });
      }
    }

    await LocationPing.create({
      user: req.user.id,
      date,
      recordedAt: now,
      lat, lng,
      accuracy: accNum,
      speed:    typeof speed    === 'number' ? speed    : null,
      presence: 'active',
    });

    res.json({ ok: true, stationary: false });
  } catch (err) {
    console.error('locationPing error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * POST /api/attendance/presence    (JWT)
 * Body: { state: 'active'|'idle'|'offline' }
 *
 * Mobile pushes presence transitions independent of location pings:
 *   • active  — net ON + GPS ON
 *   • idle    — net ON + GPS OFF
 *   • offline — sent JUST BEFORE the app goes background/disconnects
 */
exports.setPresence = async (req, res) => {
  try {
    const valid = ['active', 'idle', 'offline'];
    const state = String((req.body || {}).state || '').toLowerCase();
    if (!valid.includes(state)) {
      return res.status(400).json({ message: `state must be one of: ${valid.join(', ')}` });
    }
    await User.findByIdAndUpdate(req.user.id, {
      presence: state,
      lastSeenAt: new Date(),
    });
    res.json({ ok: true, state });
  } catch (err) {
    console.error('setPresence error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * POST /api/attendance/auto-checkout    (JWT)
 * Body: { reason?: 'gps-off'|'app-killed' }
 *
 * Mobile fires this when location services go OFF while the user is still
 * checked in. Sets checkOut to "now", marks autoCheckedOut=true, flips
 * presence to 'idle'. Idempotent — re-firing is a no-op.
 */
exports.autoCheckOut = async (req, res) => {
  try {
    const date   = todayISO();
    const record = await Attendance.findOne({ user: req.user.id, date });
    if (!record || !record.checkIn) {
      return res.status(400).json({ message: 'No active check-in for today.' });
    }
    if (record.checkOut) {
      // Already checked out (by user or earlier auto) — no-op.
      return res.json({ ok: true, message: 'Already checked out.', record });
    }
    const now = new Date();
    // #336 — mirror the manual checkout path: roll the running session
    // duration into accumulatedSeconds and archive the pair in sessions[].
    const sessionSeconds = Math.max(
      0,
      Math.round((now.getTime() - new Date(record.checkIn).getTime()) / 1000),
    );
    record.accumulatedSeconds = Math.max(0, (record.accumulatedSeconds || 0) + sessionSeconds);
    record.checkOut       = now;
    record.workedHours    = Math.round((record.accumulatedSeconds / 3600) * 100) / 100;
    record.autoCheckedOut = true;
    if (!Array.isArray(record.sessions)) record.sessions = [];
    record.sessions.push({
      checkIn:  record.checkIn,
      checkOut: now,
      checkInLat:  record.checkInLat  ?? null,
      checkInLng:  record.checkInLng  ?? null,
      checkOutLat: null,
      checkOutLng: null,
      durationSeconds: sessionSeconds,
    });
    if (record.workedHours < 4) record.status = 'halfday';
    await record.save();

    await User.findByIdAndUpdate(req.user.id, {
      presence: 'idle',
      lastSeenAt: now,
    });

    res.json({ ok: true, message: 'Auto checked out (GPS off).', record });
  } catch (err) {
    console.error('autoCheckOut error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/attendance/admin/all?month=&year=&date=    (x-admin-secret)
 * Consumed by the HRMS web app via its backend proxy.
 */
/**
 * GET /api/attendance/ping-history?date=YYYY-MM-DD
 * Returns the logged-in user's location pings for the given day (defaults
 * to today). Used by the HR / audit view in the mobile app.
 */
exports.pingHistory = async (req, res) => {
  try {
    const LocationPing = require('../models/LocationPing');
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const pings = await LocationPing
      .find({ user: req.user.id, date })
      .sort({ recordedAt: 1 })
      .lean();
    res.json({ count: pings.length, date, pings });
  } catch (err) {
    console.error('pingHistory error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.adminListAll = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  try {
    const q = {};
    // Date range we'll need for overlaying approved leaves.
    let rangeStart, rangeEnd;
    if (req.query.date) {
      q.date = req.query.date;
      rangeStart = rangeEnd = req.query.date;
    } else if (req.query.month && req.query.year) {
      const m = parseInt(req.query.month, 10);
      const y = parseInt(req.query.year, 10);
      const { start, end } = monthBounds(m, y);
      q.date = { $gte: start, $lte: end };
      rangeStart = start; rangeEnd = end;
    } else {
      const t = todayISO();
      q.date = t;
      rangeStart = rangeEnd = t;
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 2000, 5000);
    const items = await Attendance.find(q)
      // Pull the readable sidecar fields (designationTitle, departmentName)
      // alongside the ObjectId refs — the HRMS reshape prefers those so
      // the UI never shows raw hex.
      .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
      .sort({ date: -1, checkIn: 1 })
      .limit(limit)
      .lean();

    // ─── Late status derived from check-in time (IST) ──────────────────
    // We don't trust the stored `status` blindly: rows saved before the
    // IST-timezone fix landed (or by any client running on a UTC host)
    // were marked 'present' even though the employee actually clocked in
    // after 10:01 AM local. We re-derive the late flag from the check-in
    // timestamp here so every consumer (HRMS Attendance Logs, Reports,
    // Dashboard) sees the correct value without a DB migration.
    const istHm = (d) => {
      try {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(new Date(d));
        return {
          h: parseInt(parts.find(p => p.type === 'hour')?.value   || '0', 10),
          m: parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10),
        };
      } catch { return { h: 0, m: 0 }; }
    };
    for (const a of items) {
      if (!a.checkIn) continue;
      // #352a — Only override present/late/absent based on arrival time.
      // Leave / permission / halfday rows keep their own status because:
      //   • permission = manager approved a late-arrival regularisation
      //     request, and we must not overwrite that back to Absent.
      //   • halfday   = set at checkout because worked hours were < 5;
      //     unrelated to arrival time.
      //   • leave     = HR pre-approved leave; time-of-day irrelevant.
      const s = String(a.status || '').toLowerCase();
      if (s !== 'present' && s !== 'late' && s !== 'absent') continue;
      const { h, m } = istHm(a.checkIn);
      const mins = h * 60 + m;
      if (mins < 10 * 60 + 1) {
        a.status = 'present';
      } else if (mins <= 10 * 60 + 30) {
        a.status = 'late';
      } else {
        // > 10:30 AM check-in — reclassify to Absent (unless the row was
        // already flipped to Permission by a manager-approved
        // regularisation, which we skipped above).
        a.status = 'absent';
      }
    }

    // ─── Overlay approved leaves + permissions onto the day(s) ────────
    // An employee on approved Leave / Permission for a day still needs to
    // appear on HRMS Attendance Logs even when they never tapped Check-In
    // (which is the usual case for full leave days). We synthesize a
    // pseudo-attendance row for each leave/permission covering the queried
    // day(s) and merge it into the response if no real attendance row
    // exists for that user + date.
    try {
      const seen = new Set(items.map(a => String(a.user?._id || a.user) + '|' + a.date));
      const leaves = await Leave.find({
        status: 'approved',
        $or: [
          // Leave whose [startDate, endDate] window overlaps the range.
          { requestType: 'leave',      startDate: { $lte: rangeEnd }, endDate: { $gte: rangeStart } },
          // Permission whose single `date` falls inside the range.
          { requestType: 'permission', date: { $gte: rangeStart, $lte: rangeEnd } },
        ],
      })
        .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
        .limit(limit)
        .lean();

      const overlay = [];
      for (const lv of leaves) {
        if (!lv.user) continue;
        // Build the set of dates this leave covers inside the query range.
        const dates = [];
        if (lv.requestType === 'permission') {
          if (lv.date && lv.date >= rangeStart && lv.date <= rangeEnd) dates.push(lv.date);
        } else {
          // Walk start..end day-by-day and add every covered date that
          // also intersects the queried range.
          const s = new Date(Math.max(new Date(lv.startDate || rangeStart), new Date(rangeStart)));
          const e = new Date(Math.min(new Date(lv.endDate   || rangeStart), new Date(rangeEnd)));
          for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
            dates.push(d.toISOString().slice(0, 10));
          }
        }
        for (const date of dates) {
          const key = String(lv.user._id) + '|' + date;
          if (seen.has(key)) continue;        // real attendance row wins
          seen.add(key);
          overlay.push({
            _id:    'lv-' + lv._id + '-' + date,
            user:   lv.user,
            date,
            status: lv.requestType === 'permission' ? 'permission' : 'leave',
            checkIn:  null,
            checkOut: null,
            // Permission carries the time-of-day window; full-day leave does not.
            startTime: lv.startTime || null,
            endTime:   lv.endTime   || null,
            durationHours: lv.durationHours || null,
            // Flag so the HRMS UI can distinguish overlayed rows if it wants.
            isOverlay: true,
            leaveType: lv.leaveType || lv.permissionType || '',
            reason:    lv.reason    || '',
          });
        }
      }
      items.push(...overlay);
    } catch (e) {
      console.warn('[attendance.adminListAll] leave overlay failed:', e.message);
    }

    res.json({ count: items.length, items });
  } catch (err) {
    console.error('attendance.adminListAll error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/attendance/admin/live-locations
 * Header: x-admin-secret
 *
 * Returns every employee's most recent GPS sample + a derived status:
 *   offline    — no ping in last 10 min OR last presence was 'offline'
 *   office     — within OFFICE_RADIUS_M metres of OFFICE_LAT/OFFICE_LNG
 *   travelling — recent speed > 0.8 m/s
 *   active     — otherwise (stationary, away from office)
 *
 * Office defaults to the Google-Maps pin for
 *   "Tesco Structures, 37, 15th St, Gandhi Nagar, Ashok Nagar, Chennai 600083"
 * (13.0412 N, 80.2127 E) with a 200 m haversine radius. The lat/lng can
 * be overridden per-environment via OFFICE_LAT / OFFICE_LNG env vars.
 */
exports.adminLiveLocations = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  // ── Office anchor resolution (#281 — Jun 2026) ────────────────────
  // Priority order:
  //   1. SystemConfig.officeAnchor in MongoDB (HR manually pinned it).
  //   2. OFFICE_LAT / OFFICE_LNG env vars.
  //   3. Code defaults.
  //
  // The DB-locked value WINS so we don't accidentally drift back to
  // the env default after a deploy. It also never auto-recalculates —
  // it only changes when HR explicitly POSTs to /admin/lock-office.
  let OFFICE_LAT      = parseFloat(process.env.OFFICE_LAT      || '13.0412');
  let OFFICE_LNG      = parseFloat(process.env.OFFICE_LNG      || '80.2127');
  let OFFICE_RADIUS_M = parseFloat(process.env.OFFICE_RADIUS_M || '60');
  let OFFICE_NAME     = 'Tesco Structures HQ';
  try {
    const SystemConfig = require('../models/SystemConfig');
    if (SystemConfig) {
      const cfg = await SystemConfig.findOne({}).lean();
      const anchor = cfg && cfg.officeAnchor;
      if (anchor && typeof anchor.lat === 'number' && typeof anchor.lng === 'number') {
        OFFICE_LAT      = anchor.lat;
        OFFICE_LNG      = anchor.lng;
        OFFICE_RADIUS_M = typeof anchor.radiusM === 'number' ? anchor.radiusM : OFFICE_RADIUS_M;
        OFFICE_NAME     = anchor.name || OFFICE_NAME;
      }
    }
  } catch (e) {
    console.warn('[adminLiveLocations] SystemConfig read failed — using env vars:', e?.message);
  }

  const distMeters = (lat1, lng1, lat2, lng2) => {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  try {
    const employees = await User.find({})
      .select('firstName lastName name employeeId email designation department presence lastLocation lastSeenAt')
      .lean();

    const todayIso = new Date().toISOString().slice(0, 10);

    // Pull today's attendance rows in one shot so we can:
    //   (a) skip employees who already checked out — they should NOT
    //       appear on the live map any more
    //   (b) surface check-in time + worked-so-far on each row
    const todayAtt = await Attendance.find({ date: todayIso })
      .select('user checkIn checkOut workedHours')
      .lean();
    const attByUser = new Map();
    for (const a of todayAtt) attByUser.set(String(a.user), a);

    const out = await Promise.all(employees.map(async (u) => {
      const att = attByUser.get(String(u._id));
      // If the employee has not checked in today, OR has already checked
      // out, they shouldn't show on the live map.
      if (!att || !att.checkIn || att.checkOut) {
        return null;
      }

      let lat = null, lng = null, speed = null, recordedAt = null, accuracy = null;
      try {
        const ping = await LocationPing.findOne({ user: u._id, date: todayIso })
          .sort({ recordedAt: -1 })
          .lean();
        if (ping) {
          lat = ping.lat; lng = ping.lng;
          speed = ping.speed; accuracy = ping.accuracy;
          recordedAt = ping.recordedAt;
        }
      } catch { /* no pings collection yet */ }

      if (lat == null && u.lastLocation && u.lastLocation.lat != null) {
        lat = u.lastLocation.lat;
        lng = u.lastLocation.lng;
        recordedAt = u.lastSeenAt;
      }
      // Last resort: the check-in coords themselves.
      if (lat == null && att.checkInLat != null && att.checkInLng != null) {
        lat = att.checkInLat;
        lng = att.checkInLng;
        recordedAt = att.checkIn;
      }

      let status = 'offline';
      let site   = 'Last known location';
      if (lat != null && lng != null) {
        // PRESENCE-FIRST RULE (Jun 2026 HR policy):
        // The mobile app calls setPresence('offline') the moment device
        // location is detected as off. We honour that immediately — no
        // grace window — so HRMS flips the row to "Offline" on the very
        // next 45 sec poll. If we waited for the ping to age past the
        // 25-min stale window, HR would still see the employee as
        // active for up to 25 min after they'd turned location off.
        if (u.presence === 'offline') {
          status = 'offline';
          site   = 'Location off';
          // Resolve labels + return early before any geofence/freshness logic
          const [deptLabel0, roleLabel0] = await Promise.all([
            resolveLabel(u.department,  'dept'),
            resolveLabel(u.designation, 'desig'),
          ]);
          const fullName0 = u.name || ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || 'Unknown';
          return {
            _id:        u._id,
            name:       fullName0,
            employeeId: u.employeeId || '',
            email:      u.email || '',
            role:       roleLabel0,
            dept:       deptLabel0,
            lat, lng, speed, accuracy,
            status, site,
            lastSeen:   recordedAt,
            route:      null,
          };
        }

        const ageMin = recordedAt ? (Date.now() - new Date(recordedAt).getTime()) / 60000 : 999;
        // #370 — Widened from 10 → 15 min. Android Doze deep-mode cycles
        // routinely delay work by 15 min even on whitelisted apps, so a
        // 10-min window flagged the whole fleet Offline whenever the
        // screen was locked for a while. 15 min bridges normal Doze
        // without letting truly-dead sessions linger too long. Paired
        // with the mobile app's four redundant recovery layers this
        // gives HR a realistic real-time picture again.
        const stale = ageMin > 15;

        if (!stale) {
          // ── FRESH PING WINS ────────────────────────────────────────
          // A ping less than 10 min old is strong evidence that GPS is
          // currently on. Decide between office and travelling from the
          // geo + speed sample.
          const d = distMeters(lat, lng, OFFICE_LAT, OFFICE_LNG);
          if (d <= OFFICE_RADIUS_M) {
            status = 'office';
            site   = 'Tesco Structures HQ';
          } else {
            status = 'travelling';
            site   = 'On the move';
          }
        } else {
          // STALE / NO RECENT PING.
          //
          // We don't actually KNOW what's happening on the phone unless
          // the mobile app explicitly told us via setPresence('offline').
          // Pings can stop for many reasons even with GPS on:
          //   • OEM battery saver killed the foreground service
          //   • Network died for >10 min
          //   • User force-stopped the app from Recent Apps
          //   • Phone rebooted and the user hasn't opened the app yet
          //
          // The old code labelled all of these as "Location off", which
          // was a lie when the user's GPS was actually on — HR would
          // hassle the employee about turning location on when in fact
          // they had. Fix: only say "Location off" when the mobile app
          // EXPLICITLY reported it. Otherwise just say "Offline (no
          // recent location)" — honest about our uncertainty.
          if (u.presence === 'offline') {
            // User physically turned off device location (handleGpsOffWarn
            // in the mobile app called setPresence('offline')). This is
            // the ONLY signal that lets us assert "Location off".
            status = 'offline';
            site   = 'Location off';
          } else {
            // No explicit offline signal, just no fresh pings. We don't
            // know whether GPS is on or off — surface that honestly.
            status = 'offline';
            site   = 'No recent location';
          }
        }
      }

      // ── Resolve dept/designation ObjectIds → human labels.
      const [deptLabel, roleLabel] = await Promise.all([
        resolveLabel(u.department,  'dept'),
        resolveLabel(u.designation, 'desig'),
      ]);

      // Travel trail for the polyline on HRMS Live Tracking — only
      // attached for travelling employees (others don't have a useful trail).
      let route = null;
      if (status === "travelling") {
        try {
          const pings = await LocationPing.find({ user: u._id, date: todayIso })
            .sort({ recordedAt: 1 })
            .limit(50)
            .select("lat lng recordedAt")
            .lean();
          if (pings.length >= 2) {
            route = pings.map((p) => ({ lat: p.lat, lng: p.lng, t: p.recordedAt }));
          }
        } catch { /* non-fatal */ }
      }

      const fullName = u.name || ((u.firstName || "") + " " + (u.lastName || "")).trim() || "Unknown";
      // Movement derived from the latest anti-jitter signal. Mobile sets
      // stationary=true when the held anchor is what just got sent
      // (employee hasn't moved >20 m or 0.5 m/s).
      const movement = (status === 'offline' || status == null)
        ? null
        : (u.lastLocation && u.lastLocation.stationary ? 'stationary' : 'moving');
      return {
        _id:        String(u._id),
        name:       fullName,
        employeeId: u.employeeId || "",
        email:      u.email || "",
        role:       roleLabel,
        dept:       deptLabel,
        lat, lng, speed, accuracy,
        site,
        status,
        movement,
        route,
        checkInAt:  att.checkIn,
        lastSeen:   recordedAt,
      };
    }));

    res.json({
      success: true,
      office:  { lat: OFFICE_LAT, lng: OFFICE_LNG, radiusM: OFFICE_RADIUS_M, name: OFFICE_NAME },
      data:    out.filter(Boolean),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("attendance.adminLiveLocations error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

/**
 * GET /api/attendance/admin/daily-route
 *   ?employeeId=TES047          (preferred)  OR
 *   ?userId=<mongo objectId>
 *   &date=YYYY-MM-DD            (required)
 *   &trim=1                     (optional, default 1 — clip to checkIn/checkOut)
 *
 * Header: x-admin-secret
 *
 * Returns the day's route for one employee:
 *   {
 *     success: true,
 *     employee: { employeeId, name, email },
 *     date,
 *     checkIn, checkOut,
 *     checkInLat, checkInLng, checkOutLat, checkOutLng,
 *     totalDistanceKm,   // canonical km used for petrol section
 *     distanceSource,    // 'gps' | 'pins' | 'none'
 *     polyline: [{ lat, lng, at }],
 *     from: { lat, lng, at } | null,
 *     to:   { lat, lng, at } | null,
 *     allowance: { fromLocation, toLocation, fromLat, fromLng, toLat, toLng, distance, status } | null,
 *   }
 *
 * Used by HRMS for:
 *   • Allowance.jsx — map the route under each travel/petrol request
 *   • Daily route view — pick any employee + date, see polyline + km,
 *     regardless of whether they raised an allowance request.
 */
/**
 * GET /api/attendance/admin/daily-routes?date=YYYY-MM-DD
 *
 * Lightweight "every employee's km for the picked day" table. No
 * polyline — just one row per employee with name, employee id, check
 * in / out, total km (GPS-derived) and an allowance flag. HRMS "Daily
 * Routes" page calls this to populate the listing; users then click a
 * row to drill into the full polyline via adminDailyRoute.
 *
 * Was previously dropped by an unrelated file-tail rewrite, which is
 * why `routes/attendance.js` was crashing with "handler must be a
 * function" at boot — `adminDailyRoutesList` was undefined on import.
 */
exports.adminDailyRoutesList = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected)        return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date=YYYY-MM-DD required' });
    }
    // Every attendance record on this date — that's our "did this
    // employee work today" set. We populate the user for the name +
    // employeeId sidecar.
    const att = await Attendance.find({ date })
      .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
      .lean();
    // Pre-load every allowance for the date so we can mark which
    // employee filed one (allows HRMS to highlight rows whose km
    // should be cross-checked against the claim).
    const Allowance = require('../models/Allowance');
    const allowances = await Allowance.find({ date }).lean();
    const allowByUser = new Map(allowances.map((a) => [String(a.user), a]));

    // Parallelize buildDailyRoute across employees (#284 prod fix).
    // Was a sequential for-of loop — with 50 employees @ 200ms each
    // (polyline simplification + Mongo round-trip), the response took
    // 10+ seconds, frequently exceeding Render's edge timeout. Now
    // Promise.all runs them concurrently; total time is roughly the
    // slowest single row, not the sum. Mongoose connection pool
    // handles the concurrent queries fine.
    const items = await Promise.all(att.map(async (a) => {
      let route;
      try {
        route = await buildDailyRoute(a.user?._id || a.user, date, {
          checkIn:    a.checkIn,
          checkOut:   a.checkOut,
          checkInLat: a.checkInLat,
          checkInLng: a.checkInLng,
          checkOutLat: a.checkOutLat,
          checkOutLng: a.checkOutLng,
        });
      } catch (err) {
        // One employee's polyline computation failing must not take
        // down the whole list — return a zero row and keep going.
        console.warn('[adminDailyRoutesList] buildDailyRoute failed for', a.user, err.message);
        route = { distanceKm: 0, source: 'error' };
      }
      const u = a.user || {};
      const fullName =
        u.name ||
        ((u.firstName || '') + ' ' + (u.lastName || '')).trim() ||
        '—';
      const allow = allowByUser.get(String(u._id || a.user));
      return {
        _id:         String(u._id || a.user),
        employeeId:  u.employeeId || '',
        name:        fullName,
        email:       u.email || '',
        designation: u.designationTitle || u.designation || '',
        department:  u.departmentName  || u.department  || '',
        date,
        checkIn:     a.checkIn  || null,
        checkOut:    a.checkOut || null,
        status:      a.status   || '',
        distanceKm:  route.distanceKm,
        source:      route.source,
        hasAllowance: !!allow,
        allowanceStatus: allow ? allow.status : '',
      };
    }));
    res.json({ count: items.length, items });
  } catch (err) {
    console.error('[attendance.adminDailyRoutesList]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.adminDailyRoute = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected)        return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date=YYYY-MM-DD is required' });
    }

    // Resolve user. Prefer employeeId (TES047) for HR ergonomics; fall back
    // to raw userId. Both look up against the same User collection.
    const empIdRaw = String(req.query.employeeId || '').trim().toUpperCase();
    const userId   = String(req.query.userId    || '').trim();
    let user;
    if (empIdRaw) {
      user = await User.findOne({ employeeId: empIdRaw })
        .select('firstName lastName name employeeId email designation department')
        .lean();
    }
    if (!user && userId && /^[a-f0-9]{24}$/i.test(userId)) {
      user = await User.findById(userId)
        .select('firstName lastName name employeeId email designation department')
        .lean();
    }
    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Pull every ping for the day, ordered chronologically. We trust the
    // anti-jitter filter on the mobile side to have suppressed stationary
    // points — every row here represents real motion.
    const pings = await LocationPing.find({ user: user._id, date })
      .sort({ recordedAt: 1 })
      .select('lat lng recordedAt accuracy speed')
      .lean();

    // Total km via Haversine along consecutive points. Matches the
    // formula used by the petrol auto-bill so the two stay in sync.
    const distMeters = (a, b) => {
      const R = 6371000;
      const toRad = d => d * Math.PI / 180;
      const dLat = toRad(b.lat - a.lat);
      const dLng = toRad(b.lng - a.lng);
      const s = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };
    let totalM = 0;
    for (let i = 1; i < pings.length; i++) {
      totalM += distMeters(pings[i - 1], pings[i]);
    }
    const route = pings.map(p => ({ lat: p.lat, lng: p.lng, t: p.recordedAt }));
    const fullName = user.name || ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || 'Unknown';

    return res.json({
      success: true,
      employee: {
        _id: String(user._id),
        name: fullName,
        employeeId: user.employeeId || '',
        email: user.email || '',
      },
      date,
      route,
      // Frontend looks for several field names from older versions of
      // this endpoint; emit ALL of them so the existing HRMS bundle and
      // RouteMapModal both render without a redeploy.
      polyline: route,
      points:   route,
      totalKm:         Number((totalM / 1000).toFixed(2)),
      totalDistanceKm: Number((totalM / 1000).toFixed(2)),
    });
  } catch (err) {
    console.error('adminDailyRoute error:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * POST /api/attendance/admin/lock-office     (x-admin-secret)
 *
 * Permanently anchor the office to a specific employee's current GPS
 * location. Reads `User.lastLocation` for the employee and writes it
 * to the SystemConfig singleton. From the next live-tracking poll
 * onwards, `adminLiveLocations` returns these coords as the office
 * centre — surviving deploys, dyno restarts, and env-var changes.
 *
 * Does NOT auto-recalculate. The anchor stays exactly where this call
 * pinned it until HR explicitly calls this endpoint again with a
 * different employee, or DELETE /admin/lock-office is invoked.
 *
 * Body:  { employeeId: "TES047" }   // or { lat, lng } for direct override
 * Reply: { success, officeAnchor }
 */
exports.lockOfficeAnchor = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected)        return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  const SystemConfig = require('../models/SystemConfig');
  if (!SystemConfig) {
    return res.status(503).json({ message: 'SystemConfig model not loaded.' });
  }

  try {
    const body = req.body || {};
    const empIdRaw = String(body.employeeId || '').trim().toUpperCase();

    // Resolution paths:
    //   (a) employeeId  → read User.lastLocation for that person.
    //   (b) lat + lng   → trust the explicit coords (manual override).
    let anchor = null;
    let sourceMethod = null;
    let sourceEmpId = null;
    let sourceEmpName = null;

    if (empIdRaw) {
      const user = await User.findOne({ employeeId: empIdRaw })
        .select('firstName lastName name employeeId lastLocation')
        .lean();
      if (!user) {
        return res.status(404).json({ message: `Employee ${empIdRaw} not found.` });
      }
      const loc = user.lastLocation || {};
      if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
        return res.status(409).json({
          message: `Employee ${empIdRaw} has no current GPS location on record. Ask them to open the ERM app while at the office, then retry.`,
        });
      }
      anchor = { lat: loc.lat, lng: loc.lng };
      sourceMethod = 'employee-gps';
      sourceEmpId   = user.employeeId;
      sourceEmpName = user.name || ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
    } else if (typeof body.lat === 'number' && typeof body.lng === 'number' && isFinite(body.lat) && isFinite(body.lng)) {
      anchor = { lat: body.lat, lng: body.lng };
      sourceMethod = 'manual';
    } else {
      return res.status(400).json({
        message: "Provide either employeeId (uses their last GPS) or explicit lat/lng (direct).",
      });
    }

    const name    = typeof body.name    === "string" ? body.name.trim()    : "Tesco Structures HQ";
    const radiusM = typeof body.radiusM === "number" ? body.radiusM        : 60;

    const updated = await SystemConfig.findOneAndUpdate(
      {},
      {
        $set: {
          officeAnchor: {
            lat: anchor.lat,
            lng: anchor.lng,
            name,
            radiusM,
            lockedAt: new Date(),
            source: {
              employeeId:   sourceEmpId,
              employeeName: sourceEmpName,
              method:       sourceMethod,
            },
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    console.log("[lockOfficeAnchor] anchor pinned", anchor.lat, anchor.lng);
    return res.json({ success: true, officeAnchor: updated.officeAnchor });
  } catch (err) {
    console.error("lockOfficeAnchor error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// GET /api/attendance/admin/lock-office (x-admin-secret)
exports.getLockedOfficeAnchor = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || "").trim();
  const got      = (req.headers["x-admin-secret"] || "").trim();
  if (!expected)        return res.status(503).json({ message: "ADMIN_SECRET not configured." });
  if (got !== expected) return res.status(401).json({ message: "Missing/invalid x-admin-secret." });

  try {
    const SystemConfig = require("../models/SystemConfig");
    const doc = await SystemConfig.findOne({}).lean();
    return res.json({ success: true, officeAnchor: doc?.officeAnchor || null });
  } catch (err) {
    console.error("getLockedOfficeAnchor error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

/**
 * GET /api/attendance/admin/ping-analytics?date=YYYY-MM-DD
 * Header: x-admin-secret
 *
 * Per-employee tracking health for one day. For each active employee it
 * reports: check-in / check-out timestamps, ping count, first/last ping,
 * elapsed vs pinged minutes, coverage percentage, and the largest gap.
 *
 * Coverage rule: expected pings ≈ shift-minutes / 2 (1 ping per 2 min).
 * If pings received is significantly less, tracking dropped mid-shift.
 *
 * #370 — Built so HR can objectively answer "did tracking cover the
 * whole shift for every employee?" instead of eyeballing the map.
 */
exports.adminPingAnalytics = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  try {
    const User         = require('../models/User');
    const Attendance   = require('../models/Attendance');
    const LocationPing = require('../models/LocationPing');
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    // All active employees who have an attendance row for the day.
    const users = await User.find({ isActive: { $ne: false } })
      .select('_id name firstName lastName employeeId')
      .lean();

    const attRows = await Attendance.find({ date }).lean();
    const attByUser = new Map(attRows.map(a => [String(a.user), a]));

    // Aggregate pings per user in one round-trip.
    const pingsAgg = await LocationPing.aggregate([
      { $match: { date } },
      { $sort:  { user: 1, recordedAt: 1 } },
      { $group: {
          _id:       '$user',
          count:     { $sum: 1 },
          first:     { $first: '$recordedAt' },
          last:      { $last:  '$recordedAt' },
          samples:   { $push:  '$recordedAt' },
        } },
    ]);
    const pingsByUser = new Map(pingsAgg.map(p => [String(p._id), p]));

    const EXPECTED_INTERVAL_MIN = 2;   // one ping every 2 min while tracking

    const analytics = users.map(u => {
      const att   = attByUser.get(String(u._id));
      const pings = pingsByUser.get(String(u._id));
      const fullName = u.name || ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || 'Unknown';

      // No attendance row today → nothing to analyse.
      if (!att || !att.checkIn) {
        return {
          userId: u._id, employeeId: u.employeeId, name: fullName,
          checkedIn: false, pings: 0, verdict: 'never checked in',
        };
      }
      const checkIn  = new Date(att.checkIn);
      const checkOut = att.checkOut ? new Date(att.checkOut) : new Date();
      const shiftMin = Math.max(0, (checkOut.getTime() - checkIn.getTime()) / 60000);
      const pingCount = pings ? pings.count : 0;
      const firstPing = pings ? new Date(pings.first) : null;
      const lastPing  = pings ? new Date(pings.last)  : null;
      const pingedMin = firstPing && lastPing
        ? Math.max(0, (lastPing.getTime() - firstPing.getTime()) / 60000)
        : 0;

      // Largest gap between consecutive pings (minutes).
      let largestGapMin = 0;
      if (pings && Array.isArray(pings.samples) && pings.samples.length > 1) {
        for (let i = 1; i < pings.samples.length; i++) {
          const g = (new Date(pings.samples[i]).getTime()
                    - new Date(pings.samples[i-1]).getTime()) / 60000;
          if (g > largestGapMin) largestGapMin = g;
        }
      }

      const expectedPings = Math.floor(shiftMin / EXPECTED_INTERVAL_MIN);
      const coveragePct = expectedPings > 0
        ? Math.min(100, Math.round((pingCount / expectedPings) * 100))
        : 0;

      let verdict;
      if (pingCount === 0)          verdict = 'no pings received';
      else if (coveragePct >= 80)   verdict = 'healthy';
      else if (coveragePct >= 40)   verdict = 'partial';
      else                          verdict = 'poor';

      return {
        userId:       u._id,
        employeeId:   u.employeeId || '',
        name:         fullName,
        checkedIn:    true,
        checkIn:      checkIn.toISOString(),
        checkOut:     att.checkOut ? checkOut.toISOString() : null,
        shiftMinutes: Math.round(shiftMin),
        pings:        pingCount,
        expectedPings,
        coveragePct,
        firstPing:    firstPing ? firstPing.toISOString() : null,
        lastPing:     lastPing  ? lastPing.toISOString()  : null,
        pingedMinutes: Math.round(pingedMin),
        largestGapMinutes: Math.round(largestGapMin),
        verdict,
      };
    });

    // Summary counters.
    const summary = {
      totalActive:      users.length,
      checkedIn:        analytics.filter(a => a.checkedIn).length,
      healthy:          analytics.filter(a => a.verdict === 'healthy').length,
      partial:          analytics.filter(a => a.verdict === 'partial').length,
      poor:             analytics.filter(a => a.verdict === 'poor').length,
      noPings:          analytics.filter(a => a.verdict === 'no pings received').length,
      neverCheckedIn:   analytics.filter(a => a.verdict === 'never checked in').length,
    };

    res.json({ date, summary, employees: analytics });
  } catch (err) {
    console.error('adminPingAnalytics error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
