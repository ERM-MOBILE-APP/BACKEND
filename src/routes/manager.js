/**
 * Manager routes (MOBILE backend) — all require a logged-in user (JWT).
 *
 * Mirrors the ERM Web backend's /api/manager surface so the mobile Manager
 * experience has feature parity. No separate "manager role" middleware:
 * every controller resolves the caller's team via the `assignedTo` field
 * and scopes reads / 403-guards writes to that team. A signed-in employee
 * with no subordinates simply gets empty arrays and cannot act on anyone.
 */
const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const mgr     = require('../controllers/managerController');

router.get('/me',                 auth, mgr.me);
router.get('/team',               auth, mgr.team);

router.get('/leaves',             auth, mgr.leaves);
router.patch('/leaves/:id',       auth, mgr.actLeave);

router.get('/allowances',         auth, mgr.allowances);
router.patch('/allowances/:id',   auth, mgr.actAllowance);

router.get('/attendance',         auth, mgr.attendance);
router.get('/attendance-summary', auth, mgr.attendanceSummary);
router.get('/live-locations',     auth, mgr.liveLocations);

// Attendance regularisation queue — subordinates' filed requests surface
// here for the manager to approve or reject.
router.get  ('/attendance-requests',     auth, mgr.attendanceRequests);
router.patch('/attendance-requests/:id', auth, mgr.actAttendanceRequest);

// Manager-scoped announcements — posts go ONLY to the assigned team.
router.post  ('/announcements',     auth, mgr.postAnnouncement);
router.get   ('/announcements',     auth, mgr.myAnnouncements);
router.delete('/announcements/:id', auth, mgr.deleteAnnouncement);

module.exports = router;
