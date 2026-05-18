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
      transport: transport || 'Car',
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

// GET /api/allowance/my
exports.getMyAllowances = async (req, res) => {
  try {
    const allowances = await Allowance.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json(allowances);
  } catch (err) {
    console.error('getMyAllowances error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};