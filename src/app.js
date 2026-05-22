require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { startKeepAlive } = require('./keepAlive');

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
app.use('/api/announcement', require('./routes/announcement'));
app.use('/api/notification', require('./routes/notification'));
app.use('/api/complaint',    require('./routes/complaint'));

app.get('/', (req, res) => {
  res.json({
    name: 'Tesco ERM API',
    status: 'running',
    docs: '/api/health',
    endpoints: [
      'POST /api/auth/login',
      'GET  /api/health',
      'GET  /api/profile',
      'POST /api/attendance/checkin',
      'POST /api/attendance/checkout',
      'GET  /api/attendance/today',
      'GET  /api/attendance/monthly',
      'POST /api/leave/apply',
      'POST /api/leave/permission',
      'POST /api/allowance/submit',
      'GET  /api/announcement',
      'POST /api/announcement',
      'GET  /api/notification',
      'PATCH /api/notification/read-all',
    ],
  });
});

app.get('/api/health', (req, res) =>
  res.json({ ok: true, time: new Date(), uptime: process.uptime() })
);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Server error', error: err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Kick off the keep-alive cron once the server is up
  startKeepAlive(PORT);
});
