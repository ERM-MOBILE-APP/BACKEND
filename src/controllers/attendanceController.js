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
exports.checkIn = async (req, res) => {
  try {
    const date = todayISO();
    const { location = 'office', lat, lng, accuracy } = req.body || {};

    let record = await Attendance.findOne({ user: req.user.id, date });
    if (record && record.checkIn) {
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
    const isLate =
      istHour > 10 || (istHour === 10 && istMinute >= 1);
    const status = isLate ? 'late' : 'present';

    const checkInLat = (typeof lat === 'number' && isFinite(lat)) ? lat : null;
    const checkInLng = (typeof lng === 'number' && isFinite(lng)) ? lng : null;

    if (!record) {
      record = await Attendance.create({
        user: req.user.id,
        date,
        checkIn: now,
        location,
        status,
        checkInLat, checkInLng,
        autoCheckedOut: false,
      });
    } else {
      record.checkIn = now;
      record.location = location;
      record.status   = status;
      record.checkInLat = checkInLat;
      record.checkInLng = checkInLng;
      record.autoCheckedOut = false;
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
    record.workedHours =
      Math.round(((record.checkOut - record.checkIn) / 3600000) * 100) / 100;

    // ─── Early-checkout policy (Jun 2026 — wall-clock 5:30 PM IST) ────
    // HR's standard end-of-day is 5:30 PM IST. If the employee taps
    // Check Out BEFORE 5:30 PM IST, treat it as a short day:
    //   • If the employee has applied for a Permission for today
    //     (any status — pending / approved; rejected does NOT count) →
    //     status becomes 'permission'. HR is the final arbiter via the
    //     permission record; the attendance row just reflects that an
    //     early departure was filed with a reason.
    //   • If there is no permission filed at all → mark the row
    //     'halfday' with earlyCheckoutLop=true. The LOP rule
    //     (utils/leavePolicy) counts each halfday as 0.5 LOP once the
    //     employee crosses the 2-per-month free quota.
    //
    // Policy refinement (Jun 2026 HR request): the old rule required
    // APPROVED permission — but employees said it was unfair to be
    // pre-marked halfday LOP when HR hadn't acted on their request yet,
    // and HR confirmed they prefer the new rule (any non-rejected
    // permission excuses the early checkout, and if HR rejects later
    // they'll manually mark the day halfday).
    const istParts2 = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour:   '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const coHour   = parseInt(istParts2.find(p => p.type === 'hour')?.value   || '0', 10);
    const coMinute = parseInt(istParts2.find(p => p.type === 'minute')?.value || '0', 10);
    const isEarlyCheckout = coHour < 17 || (coHour === 17 && coMinute < 30);

    if (isEarlyCheckout) {
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
        // No permission filed at all → half-day LOP.
        record.status = 'halfday';
        record.earlyCheckoutLop = true;
      }
    } else {
      // Checked out at or after 5:30 PM — definitely not an early-out.
      // Clear any stale flag in case the row got re-saved.
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
exports.getToday = async (req, res) => {
  try {
    const date = todayISO();
    const record = await Attendance.findOne({ user: req.user.id, date });

    if (!record) {
      return res.json({
        date,
        shiftName: 'General Shift',
        checkIn: null,
        checkOut: null,
        location: '',
        workedHours: 0,
        status: 'absent',
      });
    }

    let workedHours = record.workedHours || 0;
    if (record.checkIn && !record.checkOut) {
      workedHours =
        Math.round(((Date.now() - new Date(record.checkIn).getTime()) / 3600000) * 100) /
        100;
    }

    res.json({
      date: record.date,
      shiftName: record.shift || 'General Shift',
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      location: record.location,
      workedHours,
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
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        workedHours: r.workedHours,
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
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        workedHours: r.workedHours,
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
    const acceptableAccuracy = accNum == null || accNum <= 50;
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
    record.checkOut       = now;
    record.workedHours    = Math.round(((now - record.checkIn) / 3600000) * 100) / 100;
    record.autoCheckedOut = true;
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
      // Only override the on-time / late distinction. Leave / permission /
      // halfday / absent rows keep their own status — those are not about
      // when the employee arrived.
      const s = String(a.status || '').toLowerCase();
      if (s !== 'present' && s !== 'late') continue;
      const { h, m } = istHm(a.checkIn);
      const isLate = h > 10 || (h === 10 && m >= 1);
      a.status = isLate ? 'late' : 'present';
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

  const OFFICE_LAT      = parseFloat(process.env.OFFICE_LAT      || '13.0412');
  const OFFICE_LNG      = parseFloat(process.env.OFFICE_LNG      || '80.2127');
  const OFFICE_RADIUS_M = parseFloat(process.env.OFFICE_RADIUS_M || '200');

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
        // 10 min stale window (tightened from 25 min in Jun 2026 at HR's
        // request). The mobile app runs four redundant recovery layers:
        //   • 30-sec foreground GPS watcher       (catches GPS toggles)
        //   • 30-sec bg-task guardian             (catches OEM kills)
        //   • OS-scheduled 90-sec background pings (the workhorse)
        //   • No self-stop on 401 — task stays armed across token blips
        // 10 min ≈ 6 missed pings, still enough to bridge a normal OEM
        // Doze cycle but tight enough that HR sees a real-time picture.
        const stale = ageMin > 10;

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
      office:  { lat: OFFICE_LAT, lng: OFFICE_LNG, radiusM: OFFICE_RADIUS_M, name: "Tesco Structures HQ" },
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

    const items = [];
    for (const a of att) {
      const route = await buildDailyRoute(a.user?._id || a.user, date, {
        checkIn:    a.checkIn,
        checkOut:   a.checkOut,
        checkInLat: a.checkInLat,
        checkInLng: a.checkInLng,
        checkOutLat: a.checkOutLat,
        checkOutLng: a.checkOutLng,
      });
      const u = a.user || {};
      const fullName =
        u.name ||
        ((u.firstName || '') + ' ' + (u.lastName || '')).trim() ||
        '—';
      const allow = allowByUser.get(String(u._id || a.user));
      items.push({
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
      });
    }
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
        .select('firstName lastName name employeeId email designation department designationTitle departmentName')
        .lean();
    } else if (userId) {
      user = await User.findById(userId)
        .select('firstName lastName name employeeId email designation department designationTitle departmentName')
        .lean();
    }
    if (!user) {
      return res.status(404).json({ message: 'Employee not found.' });
    }

    // Anchor the route window to the day's check-in / check-out span so
    // pings before/after the shift don't inflate distance.
    const att = await Attendance.findOne({ user: user._id, date }).lean();
    const route = await buildDailyRoute(user._id, date, {
      checkIn:    att?.checkIn,
      checkOut:   att?.checkOut,
      checkInLat: att?.checkInLat,
      checkInLng: att?.checkInLng,
      checkOutLat: att?.checkOutLat,
      checkOutLng: att?.checkOutLng,
    });

    // Allowance overlay — if this employee filed a travel/petrol claim
    // on the date, surface the from/to pins so the map can render F + T
    // markers alongside the GPS polyline.
    const allow = await Allowance.findOne({ user: user._id, date }).lean();
    const allowanceShape = allow ? {
      fromLocation: allow.fromLocation,
      toLocation:   allow.toLocation,
      fromLat:      allow.fromLat,
      fromLng:      allow.fromLng,
      toLat:        allow.toLat,
      toLng:        allow.toLng,
      distance:     allow.distance,
      distanceSource: allow.distanceSource,
      status:       allow.status,
    } : null;

    const fullName =
      user.name ||
      ((user.firstName || '') + ' ' + (user.lastName || '')).trim() ||
      'Unknown';

    res.json({
      success: true,
      employee: {
        _id:        String(user._id),
        employeeId: user.employeeId || '',
        name:       fullName,
        email:      user.email || '',
        designation: user.designationTitle || user.designation || '',
        department:  user.departmentName  || user.department  || '',
      },
      attendance: att ? {
        date:      att.date,
        checkIn:   att.checkIn,
        checkOut:  att.checkOut,
        status:    att.status,
        workHours: att.workHours,
      } : null,
      polyline:        route.polyline,
      route:           route.polyline,
      totalDistanceKm: route.distanceKm,
      distanceSource:  route.source,
      from:            route.from,
      to:              route.to,
      allowance:       allowanceShape,
    });
  } catch (err) {
    console.error('[attendance.adminDailyRoute]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
