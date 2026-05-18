const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');

const todayISO = () => new Date().toISOString().split('T')[0];

// POST /api/attendance/checkin  body: { location: 'remote' | 'office' }
exports.checkIn = async (req, res) => {
  try {
    const date = todayISO();
    const { location = 'office' } = req.body || {};

    let record = await Attendance.findOne({ user: req.user.id, date });
    if (record && record.checkIn) {
      return res.status(400).json({ message: 'Already checked in today' });
    }
    if (!record) {
      record = await Attendance.create({
        user: req.user.id,
        date,
        checkIn: new Date(),
        location,
        status: 'present',
      });
    } else {
      record.checkIn = new Date();
      record.location = location;
      record.status = 'present';
      await record.save();
    }
    res.json({ message: 'Checked in', record });
  } catch (err) {
    console.error('checkIn error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/attendance/checkout
exports.checkOut = async (req, res) => {
  try {
    const date = todayISO();
    const record = await Attendance.findOne({ user: req.user.id, date });
    if (!record || !record.checkIn) {
      return res.status(400).json({ message: 'You must check in first' });
    }
    if (record.checkOut) {
      return res.status(400).json({ message: 'Already checked out today' });
    }
    record.checkOut = new Date();
    record.workedHours =
      Math.round(((record.checkOut - record.checkIn) / 3600000) * 100) / 100;
    await record.save();
    res.json({ message: 'Checked out', record });
  } catch (err) {
    console.error('checkOut error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/today
exports.getToday = async (req, res) => {
  try {
    const date = todayISO();
    const record = await Attendance.findOne({ user: req.user.id, date });
    res.json(record || { date, checkIn: null, checkOut: null, status: 'absent' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/monthly?month=5&year=2026
// Merges actual attendance + approved leaves/permissions for that month
exports.getMonthly = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    });

    // Overlay leave/permission entries (those created in /leave) onto the map
    const leaves = await Leave.find({ user: req.user.id });
    const overlay = {};
    leaves.forEach(l => {
      if (l.requestType === 'permission' && l.date) {
        overlay[l.date] = 'permission';
      }
      if (l.requestType === 'leave' && l.startDate && l.endDate) {
        // best-effort: mark just the startDate if a real date
        const d = parseAnyDate(l.startDate);
        if (d) {
          const key = d.toISOString().split('T')[0];
          if (key >= start && key <= end) overlay[key] = 'leave';
        }
      }
    });

    const map = {};
    records.forEach(r => (map[r.date] = r.status));
    Object.entries(overlay).forEach(([k, v]) => (map[k] = v));

    const result = Object.entries(map).map(([date, status]) => ({ date, status }));
    res.json(result);
  } catch (err) {
    console.error('getMonthly error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// PATCH /api/attendance/mark  body: { date, status }
exports.markStatus = async (req, res) => {
  try {
    const { date, status } = req.body;
    if (!date || !['present', 'leave', 'permission', 'absent'].includes(status)) {
      return res.status(400).json({ message: 'Invalid input' });
    }
    const record = await Attendance.findOneAndUpdate(
      { user: req.user.id, date },
      { $set: { status } },
      { upsert: true, new: true }
    );
    res.json(record);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

function parseAnyDate(s) {
  if (!s) return null;
  // Accepts "DD/MM/YYYY", "MM/DD/YYYY", "Nov 24, 2024", "YYYY-MM-DD"
  const d1 = new Date(s);
  if (!isNaN(d1.getTime())) return d1;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}
