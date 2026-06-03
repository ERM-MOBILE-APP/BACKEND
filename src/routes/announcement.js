const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  list,
  getById,
  create,
  update,
  remove,
  adminCreate,
  adminUpdateByExternalId,
  adminRemoveByExternalId,
  markRead,
  markAllRead,
} = require('../controllers/announcementController');

// ─── HR / admin (x-admin-secret — consumed by HRMS web app) ──────────────
// MUST come BEFORE /:id so 'admin' isn't parsed as an id.
router.post  ('/admin',                         adminCreate);
router.patch ('/admin/by-external/:externalId', adminUpdateByExternalId);
router.delete('/admin/by-external/:externalId', adminRemoveByExternalId);

// ─── Per-user read tracking (mobile Announcements screen) ────────────────
// Mark-all-read MUST come before /:id/read so 'read-all' isn't parsed as
// an ObjectId. Both endpoints write to the current user's slice of the
// readBy array on the Announcement doc.
router.patch('/read-all',   auth, markAllRead);
router.patch('/:id/read',   auth, markRead);

// ─── Employee / mobile (JWT) ─────────────────────────────────────────────
router.get   ('/',     auth, list);
router.get   ('/:id',  auth, getById);
router.post  ('/',     auth, create);
router.patch ('/:id',  auth, update);
router.delete('/:id',  auth, remove);

module.exports = router;
