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
} = require('../controllers/leaveController');

// Static helper routes (no auth needed for dropdown lists)
router.get('/types', getLeaveTypes);
router.get('/permission-types', getPermissionTypes);

// Employee
router.post('/apply', auth, applyLeave);
router.post('/permission', auth, applyPermission);
router.get('/me', auth, getMyLeaves);
router.get('/balance', auth, getLeaveBalance);
router.delete('/:id', auth, cancelLeave);

// Admin / manager
router.get('/', auth, getAllLeaves);
router.patch('/:id/status', auth, updateLeaveStatus);

module.exports = router;
