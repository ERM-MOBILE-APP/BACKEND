const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  list,
  unreadCount,
  getById,
  create,
  markAsRead,
  markAllRead,
  remove,
  registerDevice,
  unregisterDevice,
  adminPush,
  adminBroadcast,
} = require('../controllers/notificationController');

// Server-to-server FCM fan-out (x-admin-secret) — used by the ERM Web + HRMS
// backends, which have no Firebase service account of their own. Both MUST be
// before '/:id'. /admin/push = one user; /admin/broadcast = every device.
router.post('/admin/push', adminPush);
router.post('/admin/broadcast', adminBroadcast);

router.get('/', auth, list);
router.get('/unread-count', auth, unreadCount);
router.post('/register-device', auth, registerDevice);
router.post('/unregister-device', auth, unregisterDevice);
router.patch('/read-all', auth, markAllRead);
router.get('/:id', auth, getById);
router.patch('/:id/read', auth, markAsRead);
router.delete('/:id', auth, remove);
router.post('/', auth, create);

module.exports = router;
