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
} = require('../controllers/allowanceController');

// ─── HR / admin (x-admin-secret — for HRMS web app backend proxy) ─────
// MUST come BEFORE the /:id employee routes so 'admin' isn't read as id.
router.get  ('/admin/all', adminListAll);
router.patch('/admin/:id', adminUpdate);

// ─── Employee (JWT) ─────────────────────────────────────────────────────
router.post('/submit', auth, submitAllowance);
router.get('/my', auth, getMyAllowances);
router.get('/summary', auth, getSummary);
router.get('/:id', auth, getById);
router.patch('/:id/status', auth, updateStatus);
router.delete('/:id', auth, cancel);

module.exports = router;
