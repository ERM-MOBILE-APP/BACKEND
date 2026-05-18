const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const ctrl = require('../controllers/payslipController');

router.get('/latest',  auth, ctrl.getLatest);
router.get('/history', auth, ctrl.getHistory);
router.get('/:id',     auth, ctrl.getById);

module.exports = router;
