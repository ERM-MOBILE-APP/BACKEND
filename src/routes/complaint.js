const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  create,
  list,
  getOne,
  adminListAll,
  adminUpdate,
} = require('../controllers/complaintController');

// ─── HR / admin (x-admin-secret header instead of JWT) ──────────────────
// MUST come BEFORE the /:id employee route so '/admin/all' isn't read as an id.
router.get  ('/admin/all',  adminListAll);
router.patch('/admin/:id',  adminUpdate);

// ─── Employee-facing (JWT) ───────────────────────────────────────────────
router.post('/',    auth, create);
router.get ('/',    auth, list);
router.get ('/:id', auth, getOne);

module.exports = router;
