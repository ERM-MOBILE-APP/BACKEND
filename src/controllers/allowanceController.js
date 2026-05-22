const Allowance = require('../models/Allowance');
const { notify } = require('../utils/notify');

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

    const allowance = await Allowance.create({
      user: req.user.id,
      type,
      purpose: purpose || (type === 'petrol' ? 'Daily Commute' : 'Client Meeting'),
      fromLocation,
      toLocation,
      date,
      transport: transport || (type === 'petrol' ? 'Bike' : 'Car'),
      distance: Number(distance) || 0,
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
      .populate('user', 'userId name email designation photoUrl')
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
 * HR approves/rejects an allowance and notifies the employee in-app.
 */
exports.adminUpdate = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { status, hrComment, reviewedBy } = req.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'status must be approved, rejected, or pending' });
    }
    const prev = await Allowance.findById(req.params.id);
    if (!prev) return res.status(404).json({ message: 'Allowance not found' });

    const update = { status, reviewedAt: new Date() };
    if (typeof hrComment  === 'string') update.hrComment  = hrComment;
    if (typeof reviewedBy === 'string') update.reviewedBy = reviewedBy;

    const fresh = await Allowance.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('user', 'userId name email designation photoUrl');

    // Notify employee on real status transitions only.
    try {
      if (status !== prev.status && (status === 'approved' || status === 'rejected')) {
        const kind = fresh.type === 'petrol' ? 'Petrol' : 'Travel';
        await notify(fresh.user, {
          title: `${kind} allowance ${status === 'approved' ? 'approved ✓' : 'rejected'}`,
          body:  `Your ${fmtRupees(fresh.amount)} claim (${fresh.fromLocation} → ${fresh.toLocation}, ${fresh.date}) ` +
                 `was ${status} by HR.` +
                 (hrComment ? ` Note: "${hrComment}"` : ''),
          type:  'allowance',
          link:  '/(tabs)/allowance',
        });
      }
    } catch (notifyErr) {
      console.error('[allowance.adminUpdate] notify failed:', notifyErr.message);
    }

    res.json({ message: 'Allowance updated.', allowance: fresh });
  } catch (err) {
    console.error('[allowance.adminUpdate]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
