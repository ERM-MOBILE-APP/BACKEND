const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  list,
  getById,
  create,
  update,
  remove,
} = require('../controllers/announcementController');

router.get('/', auth, list);
router.get('/:id', auth, getById);
router.post('/', auth, create);
router.patch('/:id', auth, update);
router.delete('/:id', auth, remove);

module.exports = router;
