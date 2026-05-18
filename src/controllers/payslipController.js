const Payslip = require('../models/Payslip');

/**
 * GET /api/payslip/latest
 * Returns the most recent payslip for the logged-in user.
 */
exports.getLatest = async (req, res) => {
  try {
    const payslip = await Payslip.findOne({ user: req.user.id })
      .sort({ year: -1, month: -1 })
      .lean();

    if (!payslip) {
      return res.status(404).json({ message: 'No payslip found' });
    }
    res.json(payslip);
  } catch (err) {
    console.error('getLatest payslip error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/payslip/history?year=2026
 * Returns all payslips for the user, optionally filtered by year.
 */
exports.getHistory = async (req, res) => {
  try {
    const filter = { user: req.user.id };
    if (req.query.year) {
      filter.year = parseInt(req.query.year, 10);
    }
    const payslips = await Payslip.find(filter)
      .sort({ year: -1, month: -1 })
      .lean();

    res.json(payslips);
  } catch (err) {
    console.error('getHistory payslip error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/payslip/:id
 * Returns a single payslip by ID (must belong to the logged-in user).
 */
exports.getById = async (req, res) => {
  try {
    const payslip = await Payslip.findOne({
      _id: req.params.id,
      user: req.user.id,
    }).lean();

    if (!payslip) {
      return res.status(404).json({ message: 'Payslip not found' });
    }
    res.json(payslip);
  } catch (err) {
    console.error('getById payslip error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
