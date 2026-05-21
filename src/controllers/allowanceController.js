const Allowance = require('../models/Allowance');

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
