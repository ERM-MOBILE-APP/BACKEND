const express = require('express');
const router = express.Router();
const {
  login,
  sendOtp,
  verifyOtp,
  resetPassword,
  emailStatus,
  version,
  whoami,
} = require('../controllers/authController');

router.post('/login', login);
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/reset-password', resetPassword);
router.get('/email-status', emailStatus); // diagnostic
router.get('/version', version);          // confirms which build is live
router.get('/whoami', whoami);            // shows what would match for a given email/userId

module.exports = router;
