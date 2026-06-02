const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  login,
  sendOtp,
  verifyOtp,
  resetPassword,
  changePassword,
  emailStatus,
  testEmail,
  version,
  whoami,
  adminListUsers,
  adminGetUser,
  adminCreateUser,
  adminUpdateUser,
  adminDeleteUser,
  adminLeavePolicy,
} = require('../controllers/authController');

// ─── Public ────────────────────────────────────────────────────────────
router.post('/login',           login);
router.post('/send-otp',        sendOtp);
router.post('/verify-otp',      verifyOtp);
router.post('/reset-password',  resetPassword);

// ─── JWT-protected (logged-in user actions) ──────────────────────────
router.post('/change-password', auth, changePassword);

// ─── Diagnostic ────────────────────────────────────────────────────────
router.get('/email-status',     emailStatus,
  testEmail);
router.get('/version',          version);
router.get('/whoami',           whoami);

// ─── Admin user management ─────────────────────────────────────────────
// All protected by ADMIN_SECRET env var (sent as x-admin-secret header).
// Used by:
//   • the HRMS web app's backend proxy
//   • the now-deleted standalone admin.html
router.get   ('/admin/users',                       adminListUsers);
router.get   ('/admin/users/:userId',               adminGetUser);
router.get   ('/admin/users/:userId/leave-policy',  adminLeavePolicy);
router.post  ('/admin/users',                       adminCreateUser);
router.patch ('/admin/users/:userId',               adminUpdateUser);
router.delete('/admin/users/:userId',               adminDeleteUser);

// ─── One-off DB consolidation helpers ─────────────────────────────
// Used once during the cutover to a single shared `employees` collection.
// Safe to leave in place — both require x-admin-secret.
const {
  migrateUsersToEmployees,
  dropUsersCollection,
  wipeEmployees,
} = require('../controllers/dbMigrationController');
router.post  ('/admin/migrate-users-to-employees', migrateUsersToEmployees);
router.delete('/admin/drop-users-collection',      dropUsersCollection);
router.delete('/admin/wipe-employees',             wipeEmployees);

module.exports = router;
