const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const ctrl = require('../controllers/payslipController');

router.get('/latest',  auth, ctrl.getLatest);
router.get('/history', auth, ctrl.getHistory);
router.post('/request', auth, ctrl.requestPayslip);

// ─── Admin (HRMS push) — header x-admin-secret ─────────────────────
router.post('/admin/upsert', ctrl.adminUpsert);
router.get ('/admin/list',   ctrl.adminList);

router.get('/:id',     auth, ctrl.getById);

module.exports = router;
