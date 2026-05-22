const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  applyLeave,
  applyPermission,
  getMyLeaves,
  getAllLeaves,
  updateLeaveStatus,
  cancelLeave,
  getLeaveTypes,
  getPermissionTypes,
  getLeaveBalance,
  adminListAll,
  adminUpdate,
} = require('../controllers/leaveController');

// ─── HR / admin (x-admin-secret header — for HRMS web app backend proxy)
//     MUST come BEFORE the /:id employee route so '/admin/...' doesn't get
//     swallowed by the parametric route.
router.get  ('/admin/all',  adminListAll);
router.patch('/admin/:id',  adminUpdate);

// Static helper routes (no auth needed for dropdown lists)
router.get('/types', getLeaveTypes);
router.get('/permission-types', getPermissionTypes);

// Employee
router.post('/apply', auth, applyLeave);
router.post('/permission', auth, applyPermission);
router.get('/me', auth, getMyLeaves);
router.get('/balance', auth, getLeaveBalance);
router.delete('/:id', auth, cancelLeave);

// JWT-authenticated admin / manager (legacy — kept for existing callers)
router.get('/', auth, getAllLeaves);
router.patch('/:id/status', auth, updateLeaveStatus);

module.exports = router;
