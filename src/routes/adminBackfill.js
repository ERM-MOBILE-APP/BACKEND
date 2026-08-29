/**
 * One-off backfill endpoints — gated by x-admin-secret.
 *
 * Two endpoints live here:
 *
 *   1. POST /api/admin/backfill-emp-id
 *      Stamps the `employeeId` sidecar field on every secondary collection
 *      row whose value is missing (legacy data, before the stampEmployeeId
 *      plugin was wired up). Safe to re-run.
 *
 *   2. POST /api/admin/backfill-petrol
 *      Retroactively creates the petrol Allowance row for every
 *      petrol-eligible employee who checked in/out on a given date but
 *      whose row never made it into the `allowances` collection (e.g.
 *      because the mobile backend's auto-bill block on checkOut was buggy
 *      or wasn't deployed yet). Idempotent — skips employees that already
 *      have a row for the date. This is the user-facing "fix it now"
 *      escape hatch when an eligible employee's row didn't appear after
 *      they checked out.
 *
 * Auth — both endpoints accept either:
 *   • header  `x-admin-secret: $ADMIN_SECRET`
 *   • query   `?secret=$ADMIN_SECRET`   (handy from the HRMS UI button)
 */
const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

const Allowance   = require('../models/Allowance');
const Attendance  = require('../models/Attendance');
const {
  isPetrolGpsEmployee,
  PETROL_RATE_RUPEES_PER_KM,
} = require('../petrolGpsAllowlist');
const { buildDailyRoute } = require('../controllers/attendanceController');

const COLLECTIONS = [
  'attendances',
  'attendancerequests',
  'leaves',
  'allowances',
  'complaints',
  'locationpings',
  'notifications',
  'payslips',
];

function checkAdmin(req, res) {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (
    req.headers['x-admin-secret'] ||
    req.query.secret ||
    req.body.secret ||
    ''
  ).toString().trim();
  if (!expected) { res.status(503).json({ message: 'ADMIN_SECRET not configured.' }); return false; }
  if (got !== expected) { res.status(401).json({ message: 'Missing/invalid x-admin-secret.' }); return false; }
  return true;
}

/* ────────────────────────────────────────────────────────────────────── */
/*  1. employeeId sidecar backfill                                        */
/* ────────────────────────────────────────────────────────────────────── */
router.post('/backfill-emp-id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const db   = mongoose.connection.db;
    const empCol = db.collection('employees');
    // Build a lookup from User _id → employeeId in one query.
    const employees = await empCol
      .find({}, { projection: { _id: 1, employeeId: 1 } })
      .toArray();
    const empById = new Map();
    for (const e of employees) {
      if (e.employeeId) empById.set(String(e._id), String(e.employeeId).toUpperCase());
    }

    const summary = {};
    for (const name of COLLECTIONS) {
      const col = db.collection(name);
      // Touch only rows missing or empty employeeId.
      const rows = await col
        .find({
          user: { $exists: true, $ne: null },
          $or: [{ employeeId: { $exists: false } }, { employeeId: '' }, { employeeId: null }],
        }, { projection: { _id: 1, user: 1 } })
        .toArray();
      let stamped = 0;
      for (const r of rows) {
        const empId = empById.get(String(r.user));
        if (!empId) continue;
        await col.updateOne({ _id: r._id }, { $set: { employeeId: empId } });
        stamped += 1;
      }
      summary[name] = { scanned: rows.length, stamped };
    }
    res.json({ success: true, employeesScanned: employees.length, byCollection: summary });
  } catch (err) {
    console.error('[backfill-emp-id] error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────────────── */
/*  2. Petrol allowance backfill                                          */
/*                                                                        */
/*  Scans Attendance rows for the requested date (or date range) and      */
/*  creates the missing Allowance row for every petrol-eligible employee  */
/*  who checked in. Reuses the EXACT same logic the checkOut handler      */
/*  uses (buildDailyRoute → fallback chain → ₹3.50/km).                   */
/*                                                                        */
/*  Query params:                                                         */
/*    date     YYYY-MM-DD          single day to backfill                 */
/*    from     YYYY-MM-DD          range start (inclusive)                */
/*    to       YYYY-MM-DD          range end   (inclusive)                */
/*    dryRun   1|true              don't write, just report what would    */
/*    userId   ObjectId            limit to one user (optional)           */
/*                                                                        */
/*  Default if nothing passed: today.                                     */
/* ────────────────────────────────────────────────────────────────────── */
router.post('/backfill-petrol', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  const todayISO = () => new Date().toISOString().split('T')[0];
  const isYMD    = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const single = req.query.date || req.body.date;
  const fromQ  = req.query.from || req.body.from;
  const toQ    = req.query.to   || req.body.to;
  const userIdQ = req.query.userId || req.body.userId;
  const dryRun = /^(1|true|yes)$/i.test(String(req.query.dryRun || req.body.dryRun || ''));

  let dates = [];
  if (isYMD(single)) {
    dates = [single];
  } else if (isYMD(fromQ) && isYMD(toQ)) {
    const start = new Date(fromQ + 'T00:00:00Z');
    const end   = new Date(toQ   + 'T00:00:00Z');
    if (start > end) return res.status(400).json({ message: 'from must be <= to' });
    // Hard cap at 90 days so a slip in the UI can't lock the DB.
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
      if (dates.length > 90) break;
    }
  } else {
    dates = [todayISO()];
  }

  const haversineKm = (a, b) => {
    if (!a || !b) return 0;
    if (typeof a.lat !== 'number' || typeof a.lng !== 'number') return 0;
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return 0;
    const toRad = (x) => (x * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  try {
    const empCol = mongoose.connection.db.collection('employees');
    const created = [];
    const skipped = [];
    const errors  = [];

    for (const date of dates) {
      // Find every Attendance row on this date that has at least a check-in.
      const attQ = { date, checkIn: { $ne: null } };
      if (userIdQ && /^[a-f0-9]{24}$/i.test(String(userIdQ))) {
        attQ.user = new mongoose.Types.ObjectId(String(userIdQ));
      }
      const rows = await Attendance.find(attQ).lean();

      for (const record of rows) {
        try {
          const userId = String(record.user);
          // Read the employee doc directly from the shared `employees`
          // collection so we get petrolEligible regardless of which model
          // (HRMS Employee vs mobile User) wrote it.
          const raw = await empCol.findOne({ _id: new mongoose.Types.ObjectId(userId) });
          if (!raw) {
            skipped.push({ date, userId, reason: 'employee not found' });
            continue;
          }

          const eligible = isPetrolGpsEmployee(raw);
          if (!eligible) {
            skipped.push({
              date, userId,
              employeeId: raw.employeeId || '',
              name: raw.name || `${raw.firstName || ''} ${raw.lastName || ''}`.trim(),
              reason: 'not petrol-eligible',
            });
            continue;
          }

          // Already has a row for this date? skip.
          const already = await Allowance.findOne({
            user:  raw._id,
            date,
            type:  'petrol',
          }).select('_id amount distance').lean();
          if (already) {
            skipped.push({
              date, userId,
              employeeId: raw.employeeId || '',
              reason: 'row already exists',
              existing: { id: String(already._id), amount: already.amount, distance: already.distance },
            });
            continue;
          }

          // Compute distance through the same cascade the checkOut handler uses.
          const dayRoute = await buildDailyRoute(raw._id, date, {
            checkIn:  record.checkIn,
            checkOut: record.checkOut,
          });

          let km      = 0;
          let source  = 'none';
          let fromLat = null, fromLng = null, toLat = null, toLng = null;

          if (dayRoute && Number(dayRoute.distanceKm) > 0) {
            km     = Number(dayRoute.distanceKm);
            source = dayRoute.source || 'gps';
            if (dayRoute.from) { fromLat = dayRoute.from.lat; fromLng = dayRoute.from.lng; }
            if (dayRoute.to)   { toLat   = dayRoute.to.lat;   toLng   = dayRoute.to.lng;   }
          } else if (Number(record.totalDistanceKm) > 0) {
            km     = Number(record.totalDistanceKm);
            source = record.distanceSource || 'attendance';
            fromLat = record.checkInLat  ?? null;
            fromLng = record.checkInLng  ?? null;
            toLat   = record.checkOutLat ?? null;
            toLng   = record.checkOutLng ?? null;
          } else if (
            record.checkInLat != null && record.checkInLng != null &&
            record.checkOutLat != null && record.checkOutLng != null
          ) {
            const a = { lat: record.checkInLat,  lng: record.checkInLng };
            const b = { lat: record.checkOutLat, lng: record.checkOutLng };
            km     = Math.round(haversineKm(a, b) * 100) / 100;
            source = 'pins';
            fromLat = a.lat; fromLng = a.lng; toLat = b.lat; toLng = b.lng;
          }

          const amount = Math.round(km * PETROL_RATE_RUPEES_PER_KM * 100) / 100;
          const fmt = (n) => (typeof n === 'number' && isFinite(n)) ? n.toFixed(5) : '—';
          const fromLoc = (fromLat != null && fromLng != null)
            ? `Check-in (${fmt(fromLat)}, ${fmt(fromLng)})`
            : 'Check-in';
          const toLoc = (toLat != null && toLng != null)
            ? `Check-out (${fmt(toLat)}, ${fmt(toLng)})`
            : 'Check-out';

          const note =
            source === 'gps'
              ? `Backfilled by HR. GPS distance ${km.toFixed(2)} km × ₹${PETROL_RATE_RUPEES_PER_KM}/km.`
              : source === 'pins'
                ? `Backfilled by HR. Straight-line distance ${km.toFixed(2)} km between check-in and check-out × ₹${PETROL_RATE_RUPEES_PER_KM}/km.`
                : source === 'attendance'
                  ? `Backfilled by HR. Distance ${km.toFixed(2)} km from attendance totalDistanceKm × ₹${PETROL_RATE_RUPEES_PER_KM}/km.`
                  : `Backfilled by HR. No GPS distance recorded — HR may reject.`;

          if (dryRun) {
            created.push({
              date,
              userId,
              employeeId: raw.employeeId || '',
              name: raw.name || `${raw.firstName || ''} ${raw.lastName || ''}`.trim(),
              distance: km, amount, source, dryRun: true,
            });
            continue;
          }

          const newDoc = await Allowance.create({
            user:           raw._id,
            type:           'petrol',
            purpose:        'Daily field work (auto-billed from GPS — backfilled by HR)',
            fromLocation:   fromLoc,
            toLocation:     toLoc,
            date,
            transport:      'Bike',
            distance:       km,
            distanceSource: source === 'gps' || source === 'pins' || source === 'osrm-road' ? 'gps' : 'manual',
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

          created.push({
            date,
            userId,
            employeeId: raw.employeeId || '',
            name: raw.name || `${raw.firstName || ''} ${raw.lastName || ''}`.trim(),
            allowanceId: String(newDoc._id),
            distance: km, amount, source,
          });
        } catch (rowErr) {
          console.error('[backfill-petrol] row error', date, record._id, rowErr);
          errors.push({ date, attendanceId: String(record._id), error: rowErr.message });
        }
      }
    }

    res.json({
      success: true,
      dryRun,
      dates,
      createdCount: created.length,
      skippedCount: skipped.length,
      errorCount:   errors.length,
      created,
      skipped,
      errors,
    });
  } catch (err) {
    console.error('[backfill-petrol] fatal:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
