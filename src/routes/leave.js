const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  applyLeave,
  applyPermission,
  getMyLeaves,
  getAllLeaves,
  updateLeaveStatus,
} = require('../controllers/leaveController');

// Employee
router.post('/apply', auth, applyLeave);
router.post('/permission', auth, applyPermission);
router.get('/me', auth, getMyLeaves);

// Admin / manager
router.get('/', auth, getAllLeaves);
router.patch('/:id/status', auth, updateLeaveStatus);

module.exports = router;
