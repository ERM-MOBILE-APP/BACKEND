const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const { submitAllowance, getMyAllowances } = require('../controllers/allowanceController');

router.post('/submit', auth, submitAllowance);
router.get('/my', auth, getMyAllowances);

module.exports = router;