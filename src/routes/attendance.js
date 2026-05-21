const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  checkIn,
  checkOut,
  getToday,
  getMonthly,
  getCalendar,
  getSummary,
  getHistory,
  createRequest,
  listRequests,
  markStatus,
} = require('../controllers/attendanceController');

router.post('/checkin', auth, checkIn);
router.post('/checkout', auth, checkOut);
router.get('/today', auth, getToday);
router.get('/monthly', auth, getMonthly);
router.get('/calendar', auth, getCalendar);
router.get('/summary', auth, getSummary);
router.get('/history', auth, getHistory);
router.post('/request', auth, createRequest);
router.get('/requests', auth, listRequests);
router.patch('/mark', auth, markStatus);

module.exports = router;
