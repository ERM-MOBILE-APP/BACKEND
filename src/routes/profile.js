const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const { getProfile, updateProfile, myAssets } = require('../controllers/profileController');

router.get('/', auth, getProfile);
router.put('/update', auth, updateProfile);

router.get('/assets', auth, myAssets);

module.exports = router;