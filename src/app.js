require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/leave', require('./routes/leave'));
app.use('/api/allowance', require('./routes/allowance'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/payslip', require('./routes/payslip'));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Server error', error: err.message });
});

app.listen(5000, () => console.log('Server running on port 5000'));