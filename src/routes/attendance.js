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
  locationPing,
  setPresence,
  autoCheckOut,
  pingHistory,
  adminListAll,
  adminLiveLocations,
  adminDailyRoute,
  adminDailyRoutesList,
} = require('../controllers/attendanceController');

router.post ('/checkin',       auth, checkIn);
router.post ('/checkout',      auth, checkOut);
router.get  ('/today',         auth, getToday);
router.get  ('/monthly',       auth, getMonthly);
router.get  ('/calendar',      auth, getCalendar);
router.get  ('/summary',       auth, getSummary);
router.get  ('/history',       auth, getHistory);
router.post ('/request',       auth, createRequest);
router.get  ('/requests',      auth, listRequests);
router.patch('/mark',          auth, markStatus);

// ─── Live tracking ────────────────────────────────────────────────
router.post ('/location-ping', auth, locationPing);     // every 2 min while checked in
router.post ('/presence',      auth, setPresence);      // active | idle | offline
router.post ('/auto-checkout', auth, autoCheckOut);     // fires when GPS off mid-day
router.get  ('/ping-history',  auth, pingHistory);      // HR / audit view

// ─── Admin (HRMS proxy) ────────────────────────────────────────────
// Uses x-admin-secret header instead of JWT (HRMS backend → mobile backend).

router.get  ('/admin/all',             adminListAll);
router.get  ('/admin/live-locations',  adminLiveLocations);

// Daily route map + km for one employee on one date — the petrol section
// in HRMS calls this to show the path the employee actually travelled
// alongside the from/to pins they typed on the allowance form. Also
// powers the "Daily Routes" view for non-allowance employees.
router.get  ('/admin/daily-route',     adminDailyRoute);
// Lightweight "every employee's km today" table — no polyline, used to
// populate the daily routes list page in HRMS.
router.get  ('/admin/daily-routes',    adminDailyRoutesList);

module.exports = router;
