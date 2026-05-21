const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const AttendanceRequest = require('../models/AttendanceRequest');

const todayISO = () => new Date().toISOString().split('T')[0];

const monthBounds = (month, year) => {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
};

// POST /api/attendance/checkin  body: { location: 'remote' | 'office' }
exports.checkIn = async (req, res) => {
  try {
    const date = todayISO();
    const { location = 'office' } = req.body || {};

    let record = await Attendance.findOne({ user: req.user.id, date });
    if (record && record.checkIn) {
      return res.status(400).json({ message: 'Already checked in today' });
    }

    // Late if past 09:30 local
    const now = new Date();
    const isLate =
      now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() > 30);
    const status = isLate ? 'late' : 'present';

    if (!record) {
      record = await Attendance.create({
        user: req.user.id,
        date,
        checkIn: now,
        location,
        status,
      });
    } else {
      record.checkIn = now;
      record.location = location;
      record.status = status;
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
    if (record.workedHours < 4) record.status = 'halfday';
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

    if (!record) {
      return res.json({
        date,
        shiftName: 'General Shift',
        checkIn: null,
        checkOut: null,
        location: '',
        workedHours: 0,
        status: 'absent',
      });
    }

    let workedHours = record.workedHours || 0;
    if (record.checkIn && !record.checkOut) {
      workedHours =
        Math.round(((Date.now() - new Date(record.checkIn).getTime()) / 3600000) * 100) /
        100;
    }

    res.json({
      date: record.date,
      shiftName: record.shift || 'General Shift',
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      location: record.location,
      workedHours,
      status: record.status,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/monthly?month=&year=
// Returns date+status map (used by older calendar)
exports.getMonthly = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const { start, end } = monthBounds(month, year);

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    });

    const leaves = await Leave.find({ user: req.user.id });
    const overlay = {};
    leaves.forEach((l) => {
      if (l.requestType === 'permission' && l.date) overlay[l.date] = 'permission';
      if (l.requestType === 'leave' && l.startDate && l.endDate) {
        const d = parseAnyDate(l.startDate);
        if (d) {
          const key = d.toISOString().split('T')[0];
          if (key >= start && key <= end) overlay[key] = 'leave';
        }
      }
    });

    const map = {};
    records.forEach((r) => (map[r.date] = r.status));
    Object.entries(overlay).forEach(([k, v]) => (map[k] = v));

    const result = Object.entries(map).map(([date, status]) => ({ date, status }));
    res.json(result);
  } catch (err) {
    console.error('getMonthly error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/calendar?month=&year=
// Same as monthly but always returns the full attendance shape for the day
exports.getCalendar = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const { start, end } = monthBounds(month, year);

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    }).lean();

    res.json(
      records.map((r) => ({
        date: r.date,
        status: r.status,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        workedHours: r.workedHours,
      }))
    );
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/summary?month=&year=
// Counts: present, absent, late, permission, halfday, leave
exports.getSummary = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const { start, end } = monthBounds(month, year);

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    }).lean();

    const summary = {
      present: 0,
      absent: 0,
      late: 0,
      permission: 0,
      halfday: 0,
      leave: 0,
      totalDays: records.length,
    };
    records.forEach((r) => {
      if (summary[r.status] !== undefined) summary[r.status] += 1;
    });

    // Workdays elapsed in the month — for an absent fallback count when no record exists
    const lastDay = parseInt(end.split('-')[2], 10);
    const today = new Date();
    const isCurrentMonth =
      today.getFullYear() === year && today.getMonth() + 1 === month;
    const upTo = isCurrentMonth ? today.getDate() : lastDay;
    let workdays = 0;
    for (let d = 1; d <= upTo; d++) {
      const day = new Date(year, month - 1, d).getDay();
      if (day !== 0 && day !== 6) workdays++;
    }
    summary.workdaysElapsed = workdays;
    summary.absent = Math.max(
      0,
      workdays - (summary.present + summary.late + summary.halfday + summary.permission + summary.leave)
    );

    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/history?month=&year=
// Daily history list for the month
exports.getHistory = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year required' });
    }
    const { start, end } = monthBounds(month, year);

    const records = await Attendance.find({
      user: req.user.id,
      date: { $gte: start, $lte: end },
    })
      .sort({ date: -1 })
      .lean();

    res.json(
      records.map((r) => ({
        _id: r._id,
        date: r.date,
        status: r.status,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        workedHours: r.workedHours,
        location: r.location,
        shift: r.shift || 'General Shift',
      }))
    );
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/attendance/request
// body: { date, requestType?, reason?, expectedCheckIn?, expectedCheckOut? }
exports.createRequest = async (req, res) => {
  try {
    const { date, requestType, reason, expectedCheckIn, expectedCheckOut } =
      req.body || {};
    if (!date) {
      return res.status(400).json({ message: 'date is required' });
    }
    const reqDoc = await AttendanceRequest.create({
      user: req.user.id,
      date,
      requestType: requestType || 'regularize',
      reason: reason || '',
      expectedCheckIn: expectedCheckIn || '',
      expectedCheckOut: expectedCheckOut || '',
    });
    res.status(201).json(reqDoc);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/attendance/requests
exports.listRequests = async (req, res) => {
  try {
    const items = await AttendanceRequest.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// PATCH /api/attendance/mark   (existing — manual status override)
exports.markStatus = async (req, res) => {
  try {
    const { date, status } = req.body;
    if (
      !date ||
      !['present', 'leave', 'permission', 'absent', 'late', 'halfday'].includes(status)
    ) {
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
  const d1 = new Date(s);
  if (!isNaN(d1.getTime())) return d1;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}
