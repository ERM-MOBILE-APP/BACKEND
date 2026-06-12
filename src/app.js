require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const { startKeepAlive } = require('./keepAlive');
const { startAutoCloseAttendance } = require('./autoCloseAttendance');
const { startAutoPetrolBilling } = require('./autoPetrolBilling');

const app = express();

// ─── CORS — manual middleware (same as HRMS) ────────────────────────
// Three frontends consume this backend:
//   • ERM mobile app (no Origin header → always allowed)
//   • ERM web app    (origin set via CORS_ORIGINS env var)
//   • HRMS admin     (server-to-server, uses x-admin-secret instead)
//
// Manual instead of cors() package so we never run into Render-edge
// quirks where the preflight slips past the package middleware. Sets
// headers first thing on every request, short-circuits OPTIONS with
// 204 before anything else can touch the response.
//
// Set CORS_ORIGINS on Render with the deployed web-app URL, e.g.:
//   CORS_ORIGINS=https://erm-web.vercel.app,https://erm.tescocompany.in
// Leave it unset locally so npm run dev allows everything.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin.replace(/\/+$/, ''));
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',
      'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ||
        'Content-Type, Authorization, X-Admin-Email, X-Admin-Secret, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// gzip every JSON response > 1 KB. The daily-route polyline is the
// biggest payload the HRMS asks for (a few KB after simplification)
// and gzips down to roughly 30% of that. Saves ~200-500 ms on the
// HRMS-proxy round-trip, depending on the user's last-mile speed.
app.use(compression({ threshold: 1024 }));
app.use(express.json());

const { bootstrapOfficeAnchor } = require('./bootstrapOfficeAnchor');

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');
    // One-shot office anchor lock. Only fires if BOOTSTRAP_OFFICE_EMPLOYEE_ID
    // is set AND no anchor is locked yet. Safe to leave the env var in
    // place — subsequent restarts no-op once the anchor exists.
    await bootstrapOfficeAnchor();
  })
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
// Admin one-off maintenance (backfill emp id, etc.) — gated by x-admin-secret.
app.use('/api/admin',        require('./routes/adminBackfill'));

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
// Health probe used by keepAlive.js self-pinger.
app.get('/api/_health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Kick off the keep-alive cron once the server is up
  startKeepAlive(PORT);
  // Sweep open check-ins at IST midnight - mark as absent.
  startAutoCloseAttendance();
  // Auto-bill petrol for eligible employees every 5 min - no manual
  // backfill needed. Picks up anyone whose checkout's inline auto-bill
  // misfired and creates the row automatically.
  startAutoPetrolBilling();
});
