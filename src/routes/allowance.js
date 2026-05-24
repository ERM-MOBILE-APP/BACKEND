const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  submitAllowance,
  getMyAllowances,
  getSummary,
  getById,
  updateStatus,
  cancel,
  adminListAll,
  adminUpdate,
  computeDailyDistanceKm,
} = require('../controllers/allowanceController');

// ─── HR / admin (x-admin-secret — for HRMS web app backend proxy) ─────
// MUST come BEFORE the /:id employee routes so 'admin' isn't read as id.
router.get  ('/admin/all', adminListAll);
router.patch('/admin/:id', adminUpdate);

// ─── Employee (JWT) ─────────────────────────────────────────────────────
router.post('/submit', auth, submitAllowance);
router.get('/my', auth, getMyAllowances);
router.get('/summary', auth, getSummary);

// GET /api/allowance/gps-distance?date=YYYY-MM-DD
// Preview the total km the employee travelled on the given date based
// on their LocationPings. The mobile allowance form calls this on focus
// so the user sees "Live distance: 12.4 km" before they submit.
router.get('/gps-distance', auth, async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date=YYYY-MM-DD is required' });
    }
    const gps = await computeDailyDistanceKm(req.user.id, date);
    res.json({
      date,
      distanceKm: gps.distanceKm,
      from:       gps.from,
      to:         gps.to,
      source:     gps.distanceKm > 0 ? 'gps' : 'no-pings',
    });
  } catch (err) {
    console.error('gps-distance error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/:id', auth, getById);
router.patch('/:id/status', auth, updateStatus);
router.delete('/:id', auth, cancel);

module.exports = router;
