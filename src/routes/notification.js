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
} = require('../controllers/notificationController');

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
