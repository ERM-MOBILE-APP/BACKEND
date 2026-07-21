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
  adminSummary,
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
  adminListRequests,
  adminUpdateRequest,
  adminMarkStatus,
  adminPingAnalytics,
  lockOfficeAnchor,
  getLockedOfficeAnchor,
  syncMissingPings,
  myLocationPingBuckets,
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
// #416 — SQLite-as-source-of-truth batch sync. Client uploads every locally
// stored ping still pending; server dedups by (employeeId + date + localTime)
// and inserts only the missing ones in chronological order.
router.post ('/location-pings/missing-pings', auth, syncMissingPings);
// #434 — Diff/verify helper: returns the buckets this employee already has in
// MongoDB so the client can upload only the missing ones at Check-Out and
// verify completeness before deleting local SQLite records.
router.get  ('/location-pings/mine', auth, myLocationPingBuckets);
router.post ('/presence',      auth, setPresence);      // active | idle | offline
router.post ('/auto-checkout', auth, autoCheckOut);     // fires when GPS off mid-day
router.get  ('/ping-history',  auth, pingHistory);      // HR / audit view

// ─── Admin (HRMS proxy) ────────────────────────────────────────────
// Uses x-admin-secret header instead of JWT (HRMS backend → mobile backend).

router.get  ('/admin/all',             adminListAll);
// Admin endpoints for attendance regularisation requests — used by
// HRMS proxy AND by ERM Web's manager queue.
router.get  ('/admin/requests',         adminListRequests);
router.patch('/admin/requests/:id',     adminUpdateRequest);
// #352d — HR-only manual status override. Body: { userId|employeeId, date, status, note? }
router.patch('/admin/mark-status',       adminMarkStatus);
// #455 — HR-only monthly summary for ANY employee. Returns the identical
// object the employee's own /summary returns, so HRMS's Monthly Overview
// panel matches the ERM attendance cards exactly instead of recomputing.
// Query: ?employeeId=TES080&month=7&year=2026  (or ?userId=<objectId>)
router.get  ('/admin/summary',           adminSummary);
router.get  ('/admin/live-locations',  adminLiveLocations);
// #370 — Per-employee ping analytics for a date. Returns count, first/last
// ping, elapsed vs pinged minutes, coverage %, largest gap. Header:
// x-admin-secret. Query: ?date=YYYY-MM-DD (defaults to today).
router.get  ('/admin/ping-analytics',  adminPingAnalytics);

// Office anchor lock (#281). POST locks the anchor to an employee's
// current GPS (or to explicit lat/lng); GET reads the currently
// locked anchor for inspection in HRMS.
router.post ('/admin/lock-office',     lockOfficeAnchor);
router.get  ('/admin/lock-office',     getLockedOfficeAnchor);

// Daily route map + km for one employee on one date — the petrol section
// in HRMS calls this to show the path the employee actually travelled
// alongside the from/to pins they typed on the allowance form. Also
// powers the "Daily Routes" view for non-allowance employees.
router.get  ('/admin/daily-route',     adminDailyRoute);
// Lightweight "every employee's km today" table — no polyline, used to
// populate the daily routes list page in HRMS.
router.get  ('/admin/daily-routes',    adminDailyRoutesList);

module.exports = router;
