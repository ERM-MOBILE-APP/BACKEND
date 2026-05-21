const express = require('express');
const router = express.Router();
const {
  login,
  sendOtp,
  verifyOtp,
  resetPassword,
  emailStatus,
} = require('../controllers/authController');

router.post('/login', login);
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/reset-password', resetPassword);
router.get('/email-status', emailStatus); // diagnostic

module.exports = router;
