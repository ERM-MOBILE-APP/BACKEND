const Allowance    = require('../models/Allowance');
const LocationPing = require('../models/LocationPing');
const { notify }   = require('../utils/notify');

/**
 * Search the employee's live-tracking pings for the request date and
 * derive everything the travel/petrol allowance needs:
 *
 *   • from { lat, lng } — where they were when the day started
 *                          (first ping of the day = matches "fromLocation"
 *                           text on the request)
 *   • to   { lat, lng } — where they ended up
 *                          (last ping of the day = matches "toLocation")
 *   • distanceKm        — total path length, summed haversine across
 *                          every consecutive ping pair. This is the
 *                          actual km driven, which is what petrol
 *                          reimbursement should pay for — straight-line
 *                          would underestimate any non-trivial route.
 *
 * Travel + petrol allowances now use this as the canonical distance —
 * far more accurate than HR or the employee typing it in. The mobile
 * app pings every 2 minutes while checked in, so the trail integrates
 * the whole day of movement.
 *
 * Returns { distanceKm: 0, from: null, to: null } when there are < 2
 * pings (employee wasn't checked in, GPS was off, etc.). The caller
 * decides whether to fall back to a user-typed value in that case.
 */
async function computeDailyDistanceKm(userId, dateIso) {
  if (!userId || !dateIso) return { distanceKm: 0, from: null, to: null };
  const pings = await LocationPing.find({ user: userId, date: dateIso })
    .sort({ recordedAt: 1 })
    .select('lat lng recordedAt')
    .lean();
  if (pings.length < 2) return { distanceKm: 0, from: null, to: null };

  // Haversine — straight-line distance between two lat/lng pairs.
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // km
  let totalKm = 0;
  for (let i = 1; i < pings.length; i++) {
    const a = pings[i - 1];
    const b = pings[i];
    if (typeof a.lat !== 'number' || typeof b.lat !== 'number') continue;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    totalKm += 2 * R * Math.asin(Math.sqrt(h));
  }
  const first = pings[0];
  const last  = pings[pings.length - 1];
  return {
    distanceKm: Math.round(totalKm * 100) / 100,        // 2-decimal precision
    from:       { lat: first.lat, lng: first.lng, at: first.recordedAt },
    to:         { lat: last.lat,  lng: last.lng,  at: last.recordedAt  },
  };
}

exports.computeDailyDistanceKm = computeDailyDistanceKm;

// Format a rupee amount with locale grouping (e.g. ₹12,500)
const fmtRupees = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

/**
 * Admin auth — required for HR endpoints consumed by the HRMS web app
 * via its backend proxy. Header must match the ADMIN_SECRET env var.
 */
function checkAdmin(req, res) {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) {
    res.status(503).json({ message: 'ADMIN_SECRET is not configured on the server.' });
    return false;
  }
  if (!got || got !== expected) {
    res.status(401).json({ message: 'Missing or invalid x-admin-secret header.' });
    return false;
  }
  return true;
}

// POST /api/allowance/submit
exports.submitAllowance = async (req, res) => {
  try {
    const {
      type,
      purpose,
      fromLocation,
      toLocation,
      date,
      transport,
      distance,
      amount,
      notes,
      receiptUrl,
    } = req.body;

    if (!type || !fromLocation || !toLocation || !date || amount == null || amount === '') {
      return res.status(400).json({
        message: 'Missing required fields',
        required: ['type', 'fromLocation', 'toLocation', 'date', 'amount'],
      });
    }

    // Distance — for travel/petrol we search the employee's live-tracking
    // pings on the request date and derive:
    //   • distance  = total path km driven that day (sum of consecutive
    //                  ping pair distances)
    //   • from/to   = the actual GPS coords matching the fromLocation /
    //                  toLocation text (first ping = where they started,
    //                  last ping = where they ended up)
    //
    // The text fromLocation / toLocation the user typed stays unchanged;
    // we just stamp the GPS evidence alongside it so HR can audit. If
    // there are no pings for the day, fall back to typed distance.
    let resolvedDistance = Number(distance) || 0;
    let distanceSource   = 'manual';
    let fromLat = null, fromLng = null, toLat = null, toLng = null;
    if (type === 'travel' || type === 'petrol') {
      const gps = await computeDailyDistanceKm(req.user.id, date);
      if (gps.distanceKm > 0 && gps.from && gps.to) {
        resolvedDistance = gps.distanceKm;
        distanceSource   = 'gps';
        fromLat = gps.from.lat; fromLng = gps.from.lng;
        toLat   = gps.to.lat;   toLng   = gps.to.lng;
      }
    }

    const allowance = await Allowance.create({
      user: req.user.id,
      type,
      purpose: purpose || (type === 'petrol' ? 'Daily Commute' : 'Client Meeting'),
      fromLocation,
      toLocation,
      date,
      transport: transport || (type === 'petrol' ? 'Bike' : 'Car'),
      distance: resolvedDistance,
      distanceSource,
      // GPS coords matching the from/to text — stamped at submit time so
      // even if the LocationPing rows get archived later, the allowance
      // row remembers where the employee was.
      fromLat, fromLng, toLat, toLng,
      amount: Number(amount),
      notes: notes || '',
      receiptUrl: receiptUrl || '',
    });

    res.status(201).json({ message: 'Allowance submitted', allowance });
  } catch (err) {
    console.error('submitAllowance error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/allowance/my?month=&year=&type=
exports.getMyAllowances = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    const type = req.query.type;

    const q = { user: req.user.id };
    if (type === 'travel' || type === 'petrol') q.type = type;

    let allowances = await Allowance.find(q).sort({ date: -1, createdAt: -1 }).lean();

    if (month && year) {
      allowances = allowances.filter((a) => {
        const d = new Date(a.date);
        if (isNaN(d.getTime())) return false;
        return d.getFullYear() === year && d.getMonth() + 1 === month;
      });
    }

    res.json(allowances);
  } catch (err) {
    console.error('getMyAllowances error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/allowance/summary?month=&year=&type=
// Returns approved / pending / rejected amount totals + total distance for the month
exports.getSummary = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    const type = req.query.type;
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }

    const q = { user: req.user.id };
    if (type === 'travel' || type === 'petrol') q.type = type;

    const allowances = await Allowance.find(q).lean();
    const inMonth = allowances.filter((a) => {
      const d = new Date(a.date);
      if (isNaN(d.getTime())) return false;
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    });

    const summary = {
      approved: 0,
      pending: 0,
      rejected: 0,
      totalDistance: 0,
      totalCount: inMonth.length,
    };
    inMonth.forEach((a) => {
      if (summary[a.status] !== undefined) summary[a.status] += a.amount || 0;
      summary.totalDistance += a.distance || 0;
    });
    summary.totalDistance = Math.round(summary.totalDistance);

    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/allowance/:id
exports.getById = async (req, res) => {
  try {
    const a = await Allowance.findOne({ _id: req.params.id, user: req.user.id });
    if (!a) return res.status(404).json({ message: 'Not found' });
    res.json(a);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// PATCH /api/allowance/:id/status
exports.updateStatus = async (req, res) => {
  try {
    const { status, hrComment, reviewedBy } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const update = { status, reviewedAt: new Date() };
    if (typeof hrComment === 'string') update.hrComment = hrComment;
    if (typeof reviewedBy === 'string') update.reviewedBy = reviewedBy;

    const a = await Allowance.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!a) return res.status(404).json({ message: 'Not found' });
    res.json(a);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// DELETE /api/allowance/:id
exports.cancel = async (req, res) => {
  try {
    const a = await Allowance.findOne({ _id: req.params.id, user: req.user.id });
    if (!a) return res.status(404).json({ message: 'Not found' });
    if (a.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending allowances can be cancelled' });
    }
    await a.deleteOne();
    res.json({ message: 'Cancelled' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ─── HR / Admin endpoints (consumed by HRMS web app via backend proxy) ───
// Both require the x-admin-secret header.

/**
 * GET /api/allowance/admin/all
 *   ?type=travel|petrol           (optional)
 *   ?status=pending|approved|rejected (optional)
 *   ?limit=300                    (default 300, max 1000)
 *
 * Returns every allowance across all users, newest first, with the
 * submitter populated for the HRMS UI.
 */
exports.adminListAll = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const q = {};
    const type   = String(req.query.type   || '').toLowerCase();
    const status = String(req.query.status || '').toLowerCase();
    if (type === 'travel' || type === 'petrol')                q.type   = type;
    if (['pending', 'approved', 'rejected'].includes(status))   q.status = status;

    const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);

    const items = await Allowance.find(q)
      .populate('user', 'userId employeeId firstName lastName name email designation photoUrl department designationTitle departmentName')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Quick counts for the HRMS dashboard cards.
    const counts = await Allowance.aggregate([
      { $group: {
          _id: { type: '$type', status: '$status' },
          n:   { $sum: 1 },
          sum: { $sum: '$amount' },
      } },
    ]);
    const summary = {
      total: items.length,
      pendingPetrol: 0, pendingTravel: 0,
      approvedPetrol: 0, approvedTravel: 0,
      rejectedPetrol: 0, rejectedTravel: 0,
      approvedAmount: 0,
    };
    counts.forEach((c) => {
      const t = c._id.type, s = c._id.status;
      if      (s === 'pending'  && t === 'petrol') summary.pendingPetrol  = c.n;
      else if (s === 'pending'  && t === 'travel') summary.pendingTravel  = c.n;
      else if (s === 'approved' && t === 'petrol') { summary.approvedPetrol = c.n; summary.approvedAmount += (c.sum || 0); }
      else if (s === 'approved' && t === 'travel') { summary.approvedTravel = c.n; summary.approvedAmount += (c.sum || 0); }
      else if (s === 'rejected' && t === 'petrol') summary.rejectedPetrol = c.n;
      else if (s === 'rejected' && t === 'travel') summary.rejectedTravel = c.n;
    });

    res.json({ items, summary, shown: items.length });
  } catch (err) {
    console.error('[allowance.adminListAll]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * PATCH /api/allowance/admin/:id
 * Body: { status, hrComment?, reviewedBy? }
 * HR (via x-admin-secret) updates an allowance's status. Fires a
 * notification to the employee in their mobile app.
 */
exports.adminUpdate = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { id } = req.params;
    const { status, hrComment, reviewedBy } = req.body || {};
    const allowance = await Allowance.findById(id);
    if (!allowance) return res.status(404).json({ message: 'Allowance not found' });

    if (status !== undefined)     allowance.status     = String(status).toLowerCase();
    if (hrComment !== undefined)  allowance.hrComment  = String(hrComment);
    if (reviewedBy !== undefined) allowance.reviewedBy = String(reviewedBy);
    allowance.reviewedAt = new Date();
    await allowance.save();

    try {
      const verb = allowance.status === 'approved' ? 'approved' : allowance.status === 'rejected' ? 'rejected' : 'updated';
      await notify(allowance.user, {
        title: `Allowance ${verb}`,
        body:  `Your ${allowance.type} allowance of ${fmtRupees(allowance.amount)} has been ${verb}.`,
        kind:  'allowance',
      });
    } catch (e) { console.warn('[allowance notify]', e.message); }

    res.json({ success: true, allowance });
  } catch (err) {
    console.error('adminUpdate error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
