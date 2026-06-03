/**
 * autoPetrolBilling - sweeper that auto-creates the daily petrol allowance
 * row for every petrol-eligible employee who has checked OUT but doesn't
 * have a row yet.
 *
 * Why this exists in addition to the check-out handler's auto-bill
 * ─────────────────────────────────────────────────────────────────
 * The check-out controller already tries to create the row inline when
 * the employee taps "Check Out". That works in the happy path, but
 * misfires when:
 *   - the deploy hasn't reached production yet (old code still running)
 *   - the user record's petrolEligible flag was set AFTER the employee
 *     had already checked in/out for the day
 *   - the inline write threw and was swallowed by the catch
 *   - the request raced and the row wasn't visible to Mongoose yet
 *
 * This sweeper closes those gaps automatically — HR never has to click
 * Backfill. It runs:
 *   - 30 seconds after boot (catches anything from before the deploy)
 *   - then every 5 minutes
 *
 * It only ever creates rows for TODAY and YESTERDAY (IST), so back-dated
 * data never gets retroactively billed.
 *
 * Idempotent: a row is only created when no `petrol` allowance exists for
 * the (user, date) pair. Re-running is a no-op.
 */
const mongoose = require('mongoose');
const Attendance = require('./models/Attendance');
const Allowance  = require('./models/Allowance');
const LocationPing = require('./models/LocationPing');
const {
  isPetrolGpsEmployee,
  PETROL_RATE_RUPEES_PER_KM,
} = require('./petrolGpsAllowlist');

const IST_OFFSET_MIN = 5 * 60 + 30;

function istDateStr(d) {
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

function yesterdayIstStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return istDateStr(d);
}

/* Haversine — copy of the one in attendanceController so we don't have to
   pull the whole controller in (avoids any circular-require risk). */
function haversineKm(a, b) {
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
}

/* Walk every LocationPing for (user, date) and sum the polyline length. */
async function gpsDistanceKm(userId, dateStr, opts) {
  opts = opts || {};
  const q = { user: userId, date: dateStr };
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
  if (pings.length < 2) {
    return { km: 0, source: 'none', from: null, to: null };
  }
  let total = 0;
  for (let i = 1; i < pings.length; i++) {
    total += haversineKm(pings[i - 1], pings[i]);
  }
  const first = pings[0];
  const last  = pings[pings.length - 1];
  return {
    km: Math.round(total * 100) / 100,
    source: 'gps',
    from: { lat: first.lat, lng: first.lng, at: first.recordedAt },
    to:   { lat: last.lat,  lng: last.lng,  at: last.recordedAt  },
  };
}

/* The core sweep: scan attendances for today + yesterday (IST), find
   eligible checked-out employees with no allowance row, create one. */
async function sweepOnce() {
  try {
    const dates = [istDateStr(new Date()), yesterdayIstStr()];
    const empCol = mongoose.connection.db.collection('employees');

    let created = 0;
    let scanned = 0;
    let skipped = 0;

    for (const date of dates) {
      // Need at least checkIn — checkOut is preferred but we'll create
      // even for an open checkin so the row exists by the time HR looks.
      const rows = await Attendance.find({
        date,
        checkIn:  { $ne: null },
      }).lean();

      for (const record of rows) {
        scanned++;
        try {
          const raw = await empCol.findOne({
            _id: new mongoose.Types.ObjectId(String(record.user)),
          });
          if (!raw) { skipped++; continue; }
          if (!isPetrolGpsEmployee(raw)) { skipped++; continue; }

          // Row already exists?
          const already = await Allowance.findOne({
            user: raw._id,
            date,
            type: 'petrol',
          }).select('_id').lean();
          if (already) { skipped++; continue; }

          // Compute distance via cascading fallback (mirrors checkOut handler).
          const dayRoute = await gpsDistanceKm(record.user, date, {
            checkIn:  record.checkIn,
            checkOut: record.checkOut,
          });

          let km      = 0;
          let source  = 'none';
          let fromLat = null, fromLng = null, toLat = null, toLng = null;

          if (Number(dayRoute.km) > 0) {
            km     = Number(dayRoute.km);
            source = 'gps';
            if (dayRoute.from) { fromLat = dayRoute.from.lat; fromLng = dayRoute.from.lng; }
            if (dayRoute.to)   { toLat   = dayRoute.to.lat;   toLng   = dayRoute.to.lng;   }
          } else if (Number(record.totalDistanceKm) > 0) {
            km     = Number(record.totalDistanceKm);
            source = record.distanceSource || 'attendance';
            fromLat = record.checkInLat  != null ? record.checkInLat  : null;
            fromLng = record.checkInLng  != null ? record.checkInLng  : null;
            toLat   = record.checkOutLat != null ? record.checkOutLat : null;
            toLng   = record.checkOutLng != null ? record.checkOutLng : null;
          } else if (
            record.checkInLat  != null && record.checkInLng  != null &&
            record.checkOutLat != null && record.checkOutLng != null
          ) {
            const a = { lat: record.checkInLat,  lng: record.checkInLng };
            const b = { lat: record.checkOutLat, lng: record.checkOutLng };
            km     = Math.round(haversineKm(a, b) * 100) / 100;
            source = 'pins';
            fromLat = a.lat; fromLng = a.lng; toLat = b.lat; toLng = b.lng;
          }

          const amount = Math.round(km * PETROL_RATE_RUPEES_PER_KM * 100) / 100;
          const fmt = (n) => (typeof n === 'number' && isFinite(n)) ? n.toFixed(5) : '-';
          const fromLoc = (fromLat != null && fromLng != null)
            ? `Check-in (${fmt(fromLat)}, ${fmt(fromLng)})`
            : 'Check-in';
          const toLoc = (toLat != null && toLng != null)
            ? `Check-out (${fmt(toLat)}, ${fmt(toLng)})`
            : 'Check-out';

          const note =
            source === 'gps'
              ? `Auto-billed from GPS. ${km.toFixed(2)} km x Rs.${PETROL_RATE_RUPEES_PER_KM}/km.`
              : source === 'pins'
                ? `Auto-billed. Straight-line ${km.toFixed(2)} km between check-in and check-out x Rs.${PETROL_RATE_RUPEES_PER_KM}/km.`
                : source === 'attendance'
                  ? `Auto-billed from attendance totalDistanceKm. ${km.toFixed(2)} km x Rs.${PETROL_RATE_RUPEES_PER_KM}/km.`
                  : `Auto-billed. No GPS distance recorded - HR may reject.`;

          const newDoc = await Allowance.create({
            user:           raw._id,
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

          created++;
          const tag = raw.employeeId || raw.userId || String(raw._id);
          console.log(`[autoPetrolBilling] created ${tag} ${date} km=${km} amt=Rs.${amount} src=${source} _id=${newDoc._id}`);
        } catch (rowErr) {
          console.warn(`[autoPetrolBilling] row error attendanceId=${record._id}:`, rowErr.message);
        }
      }
    }

    if (created > 0) {
      console.log(`[autoPetrolBilling] sweep done — created ${created}, scanned ${scanned}, skipped ${skipped}`);
    }
    return { created, scanned, skipped };
  } catch (err) {
    console.warn('[autoPetrolBilling] sweep failed:', err.message);
    return { created: 0, error: err.message };
  }
}

function startAutoPetrolBilling() {
  if (!process.env.MONGO_URI && process.env.NODE_ENV !== 'production') {
    return;
  }
  console.log('[autoPetrolBilling] scheduled — runs 30s after boot, then every 5 min');
  // First run 30s after boot so DB / models / mongoose connection are warm.
  setTimeout(sweepOnce, 30 * 1000);
  // Then every 5 minutes. Cheap query (today + yesterday only).
  setInterval(sweepOnce, 5 * 60 * 1000);
}

module.exports = { startAutoPetrolBilling, sweepOnce };
