const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  checkIn,
  checkOut,
  getToday,
  getMonthly,
  markStatus,
} = require('../controllers/attendanceController');

router.post('/checkin', auth, checkIn);
router.post('/checkout', auth, checkOut);
router.get('/today', auth, getToday);
router.get('/monthly', auth, getMonthly);
router.patch('/mark', auth, markStatus);

module.exports = router;
