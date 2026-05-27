const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const AttendanceRequest = require('../models/AttendanceRequest');
const LocationPing = require('../models/LocationPing');
const User = require('../models/User');

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

    // Late if check-in is past 10:01 AM local. Anyone clocking in at
    // 10:01 or later is flagged late; the cumulative late count then
    // drives the half-day / full-day LOP rule in the leave policy calc.
    const now = new Date();
    const isLate =
      now.getHours() > 10 || (now.getHours() === 10 && now.getMinutes() >= 1);
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
    if (record.workedHours < 4) record.status = 'halfday';

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
    try {
      const route = await buildDailyRoute(req.user.id, date, {
        checkIn:     record.checkIn,
        checkOut:    now,
        checkInLat:  record.checkInLat,
        checkInLng:  record.checkInLng,
        checkOutLat,
        checkOutLng,
      });
      record.totalDistanceKm = route.distanceKm;
      record.distanceSource  = route.source;
    } catch (e) {
      console.warn('[checkOut] distance compute failed:', e.message);
    }

    await record.save();

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

// GET /api/attendance/requests
exports.listRequests = async (req, res) => {
  try {
    const items = await AttendanceRequest.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(items);
  } catch (err) {
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
    const { lat, lng, accuracy, speed } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
      return res.status(400).json({ message: 'Provide numeric lat and lng.' });
    }
    const now  = new Date();
    const date = todayISO();

    // 1) Update the user's live presence + location.
    await User.findByIdAndUpdate(req.user.id, {
      presence: 'active',
      lastSeenAt: now,
      lastLocation: {
        lat, lng,
        accuracy: typeof accuracy === 'number' ? accuracy : null,
        updatedAt: now,
      },
    });

    // 2) Append the audit ping (lightweight insert, ~80 bytes per row).
    await LocationPing.create({
      user: req.user.id,
      date,
      recordedAt: now,
      lat, lng,
      accuracy: typeof accuracy === 'number' ? accuracy : null,
      speed:    typeof speed    === 'number' ? speed    : null,
      presence: 'active',
    });

    res.json({ ok: true });
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
    if (req.query.date) {
      q.date = req.query.date;
    } else if (req.query.month && req.query.year) {
      const m = parseInt(req.query.month, 10);
      const y = parseInt(req.query.year, 10);
      const { start, end } = monthBounds(m, y);
      q.date = { $gte: start, $lte: end };
    } else {
      q.date = todayISO();
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
        const ageMin = recordedAt ? (Date.now() - new Date(recordedAt).getTime()) / 60000 : 999;
        // 25 min stale window. The mobile app now runs THREE redundant
        // recovery layers:
        //   • 30-sec foreground GPS watcher        (catches GPS toggles)
        //   • 60-sec bg-task guardian              (catches OEM kills)
        //   • OS-scheduled 2-min background pings  (the workhorse)
        // 25 min = one full guardian-cycle of grace on top of the
        // theoretical worst case (12 min OEM throttle + 2 min interval +
        // network round-trip). If we hit it the task has genuinely been
        // dead long enough that "Offline" is the honest label.
        const stale  = ageMin > 25;

        if (!stale) {
          // ── FRESH PING WINS ────────────────────────────────────────
          // A ping less than 12 min old is the strongest evidence that
          // GPS is currently on, so we ignore any stale `presence='idle'`
          // left over from a previous session. Decide between office and
          // travelling purely from the geo / speed sample.
          const d = distMeters(lat, lng, OFFICE_LAT, OFFICE_LNG);
          if (d <= OFFICE_RADIUS_M) {
            status = 'office';
            site   = 'Tesco Structures HQ';
          } else {
            // Outside office geofence. If we have a real speed sample
            // assume travelling; otherwise still flag travelling rather
            // than the ambiguous "Field" / "active" we used to emit.
            status = 'travelling';
            site   = 'On the move';
          }
        } else if (u.presence === 'idle') {
          // Stale ping + presence flagged idle = GPS turned off mid-shift.
          status = 'idle';
          site   = 'Location off';
        } else if (u.presence === 'offline') {
          status = 'offline';
          site   = 'Last known location';
        } else {
          // Stale ping with no useful presence value → GPS probably off.
          status = 'idle';
          site   = 'Location off';
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
    // to raw userId. Both look up against the shared `employees` collection
    // (mobile User model points to the same collection as HRMS Employee).
    let user = null;
    const empIdRaw = String(req.query.employeeId || '').trim().toUpperCase();
    const userIdRaw = String(req.query.userId || '').trim();
    if (empIdRaw) {
      user = await User.findOne({
        $or: [{ employeeId: empIdRaw }, { userId: empIdRaw }],
      }).select('_id firstName lastName name email employeeId userId').lean();
    } else if (isObjId(userIdRaw)) {
      user = await User.findById(userIdRaw)
        .select('_id firstName lastName name email employeeId userId').lean();
    }
    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const att = await Attendance.findOne({ user: user._id, date }).lean();
    const trim = String(req.query.trim ?? '1') !== '0';

    const route = await buildDailyRoute(user._id, date, {
      checkIn:     trim && att?.checkIn  ? att.checkIn  : undefined,
      checkOut:    trim && att?.checkOut ? att.checkOut : undefined,
      checkInLat:  att?.checkInLat,
      checkInLng:  att?.checkInLng,
      checkOutLat: att?.checkOutLat,
      checkOutLng: att?.checkOutLng,
    });

    // If we have a stamped value on the Attendance row AND the live
    // compute came back empty (pings since pruned), trust the stamp.
    let totalDistanceKm = route.distanceKm;
    let distanceSource  = route.source;
    if (totalDistanceKm === 0 && att && typeof att.totalDistanceKm === 'number' && att.totalDistanceKm > 0) {
      totalDistanceKm = att.totalDistanceKm;
      distanceSource  = att.distanceSource || 'gps';
    }

    // Surface any allowance the employee filed for this date so the HRMS
    // can overlay the employee-marked from/to pins on top of the live
    // route polyline.
    const Allowance = require('../models/Allowance');
    const allow = await Allowance.findOne({ user: user._id, date }).lean();
    const allowance = allow ? {
      _id:          allow._id,
      type:         allow.type,
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
        employeeId: user.employeeId || user.userId || '',
        name:       fullName,
        email:      user.email || '',
      },
      date,
      checkIn:     att?.checkIn  || null,
      checkOut:    att?.checkOut || null,
      checkInLat:  att?.checkInLat  ?? null,
      checkInLng:  att?.checkInLng  ?? null,
      checkOutLat: att?.checkOutLat ?? null,
      checkOutLng: att?.checkOutLng ?? null,
      totalDistanceKm,
      distanceSource,
      polyline: route.polyline,
      from:     route.from,
      to:       route.to,
      allowance,
    });
  } catch (err) {
    console.error('attendance.adminDailyRoute error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/attendance/admin/daily-routes
 *   ?date=YYYY-MM-DD     (required)
 * Header: x-admin-secret
 *
 * Returns every employee's distance + checkIn/checkOut for the date —
 * lightweight (no polyline), used to populate the "Daily Routes" table
 * in HRMS so HR can pick whose route to drill into.
 */
exports.adminDailyRoutesList = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected)        return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date=YYYY-MM-DD is required' });
    }

    const Allowance = require('../models/Allowance');
    const [rows, allows] = await Promise.all([
      Attendance.find({ date })
        .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
        .lean(),
      Allowance.find({ date }).select('user type distance status fromLocation toLocation distanceSource').lean(),
    ]);

    const allowByUser = new Map();
    allows.forEach((a) => {
      const k = String(a.user);
      if (!allowByUser.has(k)) allowByUser.set(k, []);
      allowByUser.get(k).push(a);
    });

    const items = await Promise.all(rows.map(async (r) => {
      const u = r.user || {};
      const role = await resolveLabel(u.designation, 'desig').catch(() => '');
      const dept = await resolveLabel(u.department,  'dept').catch(() => '');
      const fullName = u.name || ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || 'Unknown';
      const userAllows = allowByUser.get(String(u._id)) || [];
      const petrol = userAllows.find((a) => a.type === 'petrol') || null;
      const travel = userAllows.find((a) => a.type === 'travel') || null;
      return {
        userId:         String(u._id),
        employeeId:     u.employeeId || '',
        name:           fullName,
        email:          u.email || '',
        designation:    role || u.designationTitle || '',
        department:     dept || u.departmentName   || '',
        date:           r.date,
        checkIn:        r.checkIn,
        checkOut:       r.checkOut,
        workedHours:    r.workedHours || 0,
        totalDistanceKm: typeof r.totalDistanceKm === 'number' ? r.totalDistanceKm : 0,
        distanceSource:  r.distanceSource || 'none',
        hasAllowance:   userAllows.length > 0,
        petrol: petrol ? { distance: petrol.distance, status: petrol.status, from: petrol.fromLocation, to: petrol.toLocation } : null,
        travel: travel ? { distance: travel.distance, status: travel.status, from: travel.fromLocation, to: travel.toLocation } : null,
      };
    }));

    res.json({ success: true, date, count: items.length, items });
  } catch (err) {
    console.error('attendance.adminDailyRoutesList error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
