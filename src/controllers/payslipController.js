const Payslip = require('../models/Payslip');
const User    = require('../models/User');
let   Notification;
try { Notification = require('../models/Notification'); } catch { Notification = null; }

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

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
 * POST /api/payslip/admin/upsert
 * Header: x-admin-secret
 * Body  : { employeeId | email | userId, month, year, monthLabel?, earnings, deductions, status?, paidVia? }
 *
 * Creates or updates a payslip for the target employee and fires an
 * in-app notification so the mobile user knows it's ready.
 */
exports.adminUpsert = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  try {
    const { employeeId, email, userId, month, year } = req.body || {};
    const m = parseInt(month, 10);
    const y = parseInt(year,  10);
    if (!m || m < 1 || m > 12) return res.status(400).json({ message: 'month (1-12) required' });
    if (!y) return res.status(400).json({ message: 'year required' });

    // Locate the employee/user — accept several identifiers.
    let user = null;
    if (userId)     user = await User.findById(userId);
    if (!user && employeeId) user = await User.findOne({ employeeId });
    if (!user && email)      user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) return res.status(404).json({ message: 'Employee not found for given identifiers' });

    const earnings = {
      basicSalary:      num(req.body?.earnings?.basicSalary),
      hraAllowance:     num(req.body?.earnings?.hraAllowance),
      performanceBonus: num(req.body?.earnings?.performanceBonus),
      otherEarnings:    num(req.body?.earnings?.otherEarnings),
    };
    const deductions = {
      incomeTax:       num(req.body?.deductions?.incomeTax),
      providentFund:   num(req.body?.deductions?.providentFund),
      healthInsurance: num(req.body?.deductions?.healthInsurance),
      lopDeduction:    num(req.body?.deductions?.lopDeduction),
      otherDeductions: num(req.body?.deductions?.otherDeductions),
    };
    const totalGross      = Object.values(earnings).reduce((a, b) => a + b, 0);
    const totalDeductions = Object.values(deductions).reduce((a, b) => a + b, 0);
    const netPay          = totalGross - totalDeductions;
    const monthLabel      = req.body?.monthLabel || `${MONTH_NAMES[m]} ${y}`;

    const payslip = await Payslip.findOneAndUpdate(
      { user: user._id, month: m, year: y },
      {
        user: user._id,
        month: m,
        year:  y,
        monthLabel,
        earnings,
        deductions,
        totalGross,
        totalDeductions,
        netPay,
        status:  req.body?.status  || 'processed',
        paidVia: req.body?.paidVia || 'HDFC Bank',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Notify the employee (best effort).
    if (Notification) {
      try {
        await Notification.create({
          user:   user._id,
          type:   'payslip',
          title:  `Payslip available — ${monthLabel}`,
          body:   `Your payslip for ${monthLabel} has been published. Net pay: ₹${netPay.toLocaleString('en-IN')}.`,
          link:   `/payslip/${payslip._id}`,
          isRead: false,
        });
      } catch (e) {
        console.warn('[payslip.adminUpsert] notification create failed:', e.message);
      }
    }

    return res.json({ success: true, payslip });
  } catch (err) {
    console.error('adminUpsert payslip error:', err);
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'Payslip already exists for this month/employee.' });
    }
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/payslip/admin/list?month=&year=
 * Header: x-admin-secret
 * Lists payslips (optionally filtered) so HRMS can show what's already published.
 */
exports.adminList = async (req, res) => {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) return res.status(503).json({ message: 'ADMIN_SECRET not configured.' });
  if (got !== expected) return res.status(401).json({ message: 'Missing/invalid x-admin-secret.' });

  try {
    const q = {};
    if (req.query.month) q.month = parseInt(req.query.month, 10);
    if (req.query.year)  q.year  = parseInt(req.query.year,  10);

    const items = await Payslip.find(q)
      .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
      .sort({ year: -1, month: -1, createdAt: -1 })
      .limit(Math.min(parseInt(req.query.limit, 10) || 1000, 5000))
      .lean();

    res.json({ count: items.length, items });
  } catch (err) {
    console.error('adminList payslip error:', err);
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

/**
 * POST /api/payslip/request
 * Body: { month, year }
 *
 * Employee asks HR to process their payslip for that month. Creates a
 * placeholder Payslip row with status='pending' (or marks an existing one
 * as still-pending). HR can then fulfill the request from the HRMS Payroll
 * page; only at that point is the real payslip available for download.
 */
exports.requestPayslip = async (req, res) => {
  try {
    const { month, year } = req.body || {};
    const m = parseInt(month, 10);
    const y = parseInt(year,  10);
    if (!m || m < 1 || m > 12 || !y) {
      return res.status(400).json({ message: 'month (1-12) and year are required.' });
    }
    const existing = await Payslip.findOne({ user: req.user.id, month: m, year: y });
    if (existing && existing.status === 'processed') {
      return res.status(200).json({
        message:  'Payslip already available.',
        payslip:  existing,
        already:  true,
      });
    }
    const monthName = MONTH_NAMES[m] + ' ' + y;
    const doc = existing || new Payslip({
      user:       req.user.id,
      month:      m,
      year:       y,
      monthLabel: monthName,
      status:     'pending',
    });
    doc.status     = 'pending';
    doc.monthLabel = monthName;
    await doc.save();
    return res.status(201).json({
      message: 'Request received. HR will process your payslip shortly.',
      payslip: doc,
    });
  } catch (err) {
    console.error('requestPayslip error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

