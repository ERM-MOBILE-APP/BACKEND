const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
  submitAllowance,
  getMyAllowances,
  getSummary,
  getById,
  updateStatus,
  cancel,
} = require('../controllers/allowanceController');

router.post('/submit', auth, submitAllowance);
router.get('/my', auth, getMyAllowances);
router.get('/summary', auth, getSummary);
router.get('/:id', auth, getById);
router.patch('/:id/status', auth, updateStatus);
router.delete('/:id', auth, cancel);

module.exports = router;
