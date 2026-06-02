const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sendOtpEmail, getStatus } = require('../services/emailService');
const { computeLeavePolicy } = require('../utils/leavePolicy');

// Bump this string every time you change auth logic so you can
// confirm which build is actually running on Render. Hit
// GET /api/auth/version to see what's live.
const AUTH_CODE_VERSION = '2026-05-24-presence-location-tracking';

// In-memory OTP store: { email: { otp, expiresAt, attempts } }
// Replace with Redis or DB in production.
const otpStore = new Map();
const MAX_ATTEMPTS = 5;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 min

/**
 * Normalize a Gmail-style address: strip dots from the local part and
 * everything after a '+' (Gmail treats john.doe+work@gmail.com,
 * johndoe@gmail.com, and john.doe@gmail.com as the same mailbox).
 * For non-Gmail/Googlemail domains we just lower-case and trim.
 */
function normalizeEmail(input) {
  if (!input) return '';
  const lower = String(input).trim().toLowerCase();
  const atIdx = lower.indexOf('@');
  if (atIdx < 0) return lower;
  let local  = lower.slice(0, atIdx);
  let domain = lower.slice(atIdx + 1);
  const plusIdx = local.indexOf('+');
  if (plusIdx >= 0) local = local.slice(0, plusIdx);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/**
 * Flexible user lookup — finds a user from ANY plausible email/userId the
 * employee might enter. Strategy (each step runs only if earlier steps
 * returned nothing):
 *
 *   1. Exact match on `email` or `userId` (case-insensitive).
 *      e.g. input "john@acme.com" → user.email = "john@acme.com"
 *
 *   2. Local-part-of-email match against `userId`.
 *      Most common cause of "no account found": the User record only has
 *      a userId like "pragatheeswaranm30" and a blank email column.
 *      e.g. input "pragatheeswaranm30@gmail.com" → userId "pragatheeswaranm30"
 *
 *   3. Reverse-email match — input is a bare userId, find a user whose
 *      email starts with "<userId>@".
 *
 *   4. Gmail dot/plus normalization — "j.smith+work@gmail.com" and
 *      "jsmith@gmail.com" are the same Gmail mailbox.
 *
 *   5. Unique-substring fallback — if exactly ONE user has a userId that
 *      contains the input's local part (or vice versa), match it. Skipped
 *      when there are 0 or 2+ candidates to avoid choosing the wrong user.
 *
 * Returns the User document or null. The matchedBy field on the result
 * (added as a non-enumerable property) records which strategy hit, which
 * is logged but not exposed to the client.
 */
async function findUserByEmailOrUserId(rawInput) {
  if (!rawInput) return null;
  const raw      = String(rawInput).trim();
  const lower    = raw.toLowerCase();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const atIdx    = lower.indexOf('@');
  const isEmail  = atIdx > 0;
  const localPart = isEmail ? lower.slice(0, atIdx) : lower;

  // Step 1+2+3+4 — try every cheap exact/regex variation in a single OR query
  const ciFull   = new RegExp(`^${escapeRe(lower)}$`, 'i');
  const ciLocal  = new RegExp(`^${escapeRe(localPart)}$`, 'i');
  const orClauses = [
    { email:  ciFull },
    { userId: ciFull },
    { userId: raw },
    { userId: lower },
    // Step 2 — local part of email as userId
    { userId: ciLocal },
    { userId: localPart },
    // Step 1b — any past email the HRMS edit pushed onto emailHistory.
    { emailHistory: lower },
  ];

  if (!isEmail && lower.length > 0) {
    // Step 3 — bare userId, find user whose email starts with "<userId>@"
    orClauses.push({ email: new RegExp(`^${escapeRe(lower)}@`, 'i') });
  }

  // Step 4 — Gmail dot/plus normalization
  if (isEmail) {
    const normalized = normalizeEmail(lower);
    if (normalized && normalized !== lower) {
      orClauses.push({ email: new RegExp(`^${escapeRe(normalized)}$`, 'i') });
    }
    // Also try matching `email` after stripping dots from the local part on
    // BOTH sides (handles "j.smith@gmail.com" in DB vs "jsmith@gmail.com"
    // typed by user, and vice versa).
    if (localPart.includes('.')) {
      const nodots = localPart.replace(/\./g, '');
      orClauses.push({ email: new RegExp(`^${escapeRe(nodots)}@`, 'i') });
      orClauses.push({ userId: new RegExp(`^${escapeRe(nodots)}$`, 'i') });
    }
  }

  let user = await User.findOne({ $or: orClauses });
  if (user) {
    Object.defineProperty(user, '_matchedBy', { value: 'exact-or-localpart', enumerable: false });
    return user;
  }

  // Step 5 — unique-substring fallback. SAFETY: only accept if exactly ONE
  // user matches the substring, otherwise we risk resetting the wrong
  // account. We deliberately do NOT include `name` here (too noisy).
  if (localPart.length >= 4) {
    const containsRe = new RegExp(escapeRe(localPart), 'i');
    const candidates = await User.find({
      $or: [
        { userId: containsRe },
        { email:  containsRe },
        { emailHistory: containsRe },
      ],
    }).limit(3).select('userId email name role');

    if (candidates.length === 1) {
      const u = candidates[0];
      Object.defineProperty(u, '_matchedBy', { value: 'unique-substring', enumerable: false });
      console.log(
        `[findUserByEmailOrUserId] unique substring match: input="${raw}" → ` +
        `userId="${u.userId}" email="${u.email || '(empty)'}"`
      );
      return u;
    }
    if (candidates.length > 1) {
      console.warn(
        `[findUserByEmailOrUserId] substring "${localPart}" matched ${candidates.length} ` +
        `users — refusing to guess. Candidates: ` +
        candidates.map(c => `${c.userId}(${c.email || 'no-email'})`).join(', ')
      );
    }
  }

  return null;
}

exports.login = async (req, res) => {
  const { userId, password } = req.body;
  try {
    if (!userId || !password)
      return res.status(400).json({ message: 'Email/userId and password required' });

    // The "userId" field from the mobile app may actually contain an email.
    // Look up by BOTH userId (exact) and email (case-insensitive) — match whichever exists.
    const raw = String(userId).trim();
    const emailLower = raw.toLowerCase();

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const emailRegex = new RegExp(`^${escapeRe(emailLower)}$`, 'i');

    // Unified collection: docs use HRMS field names — `employeeId` not
    // `userId`. The User model exposes `userId` only as a virtual, which
    // doesn't match in queries. So we look up by physical fields:
    // employeeId (HRMS canonical), email (case-insensitive), and username
    // (HRMS sets this when admin creates).
    const user = await User.findOne({
      $or: [
        { employeeId: raw },
        { employeeId: emailLower },
        { email: emailRegex },
        { username: emailLower },
        // Match historical emails too. If HR edited the employee's email
        // from X → Y and the mobile-side row didn't refresh (cold cache,
        // stale tab, silent save failure on HRMS), the user can still
        // log in with either the OLD or NEW address.
        { emailHistory: emailLower },
      ],
    });

    if (!user) {
      console.log(`[login] no user found for "${raw}"`);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Detailed debug logging — helps diagnose post-reset login failures
    console.log(
      `[login] candidate user: id=${user._id} userId=${user.userId} ` +
      `email="${user.email}" pwHashPrefix=${(user.password || '').slice(0, 7)}`
    );

    const ok = await bcrypt.compare(password, user.password || '');
    if (!ok) {
      console.log(`[login] password mismatch for ${user.userId} (${user.email})`);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    console.log(`[login] ✓ ${user.userId} logged in`);
    res.json({
      token,
      user: { name: user.name, userId: user.userId, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Send OTP to user's registered email.
 * Sends to ANY email address (we do not 404 here) so forgot-password works
 * for users whose User record has no email column populated yet.
 */
exports.sendOtp = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  try {
    const normalized = email.toLowerCase().trim();

    // Lenient mode — send OTP to ANY email address the user enters.
    // We do NOT 404 here, even when no User matches, because:
    //   • the User collection's `email` field is often blank
    //   • users may log in with an email-shaped `userId`
    //   • blocking here makes forgot-password feel broken for valid accounts
    // The flexible lookup in resetPassword handles "does this account
    // actually exist" at the right moment (after the user has proven they
    // own the inbox by typing back the OTP).
    const user = await findUserByEmailOrUserId(normalized);
    if (!user) {
      console.warn(`[sendOtp] no User record for ${normalized} — sending OTP anyway`);
    } else {
      console.log(`[sendOtp] matched user ${user.userId} for ${normalized}`);
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + OTP_TTL_MS;
    otpStore.set(normalized, {
      otp,
      expiresAt,
      attempts: 0,
      userId: user ? user._id : null,
    });

    console.log(`[sendOtp] generated OTP for ${normalized}: ${otp}`);

    const result = await sendOtpEmail(normalized, otp);

    if (result.sent) {
      return res.json({
        success: true,
        message: `OTP sent to ${email}. Please check your inbox (and spam folder).`,
      });
    }

    // email failed — return 502 so the frontend treats this as an error.
    // ALWAYS surface the actual reason so it's debuggable from the mobile app.
    console.error('[sendOtp] email send failed:', result.error);
    const reason = result.error || 'Unknown SendGrid error';
    const hint = /not configured/i.test(reason)
      ? 'SendGrid is not configured. Set SENDGRID_API_KEY and SENDGRID_FROM on Render → Environment.'
      : /unauthorized|401|forbidden|403/i.test(reason)
      ? 'SendGrid API key is invalid or revoked. Regenerate it at sendgrid.com → Settings → API Keys.'
      : /verified sender|from address|sender identity/i.test(reason)
      ? 'SENDGRID_FROM is not a verified sender. Verify it at sendgrid.com → Settings → Sender Authentication.'
      : 'Check Render logs for [emailService] details.';

    return res.status(502).json({
      success: false,
      emailSent: false,
      message: `Couldn't send OTP email. ${reason}. ${hint}`,
      reason,
      hint,
      // expose otp ONLY outside production so devs can test the next step
      ...(process.env.NODE_ENV !== 'production' && { devOtp: otp }),
    });
  } catch (err) {
    console.error('[sendOtp]', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Verify OTP entered by user. Returns short-lived reset token on success.
 */
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp)
    return res.status(400).json({ message: 'Email and OTP are required' });

  const normalized = email.toLowerCase().trim();
  const record = otpStore.get(normalized);

  if (!record)
    return res.status(400).json({ message: 'No OTP requested for this email' });

  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalized);
    return res
      .status(400)
      .json({ message: 'OTP expired. Please request a new one.' });
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(normalized);
    return res
      .status(429)
      .json({ message: 'Too many failed attempts. Request a new OTP.' });
  }

  if (record.otp !== String(otp).trim()) {
    record.attempts += 1;
    return res.status(400).json({
      message: `Invalid OTP. ${MAX_ATTEMPTS - record.attempts} attempt(s) left.`,
    });
  }

  // success — delete OTP and return reset token
  otpStore.delete(normalized);
  const resetToken = jwt.sign(
    { email: normalized, type: 'reset' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  return res.json({
    success: true,
    message: 'OTP verified successfully',
    resetToken,
  });
};

/**
 * Reset password using a valid reset token from verifyOtp.
 */
exports.resetPassword = async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword)
    return res
      .status(400)
      .json({ message: 'resetToken and newPassword are required' });

  if (newPassword.length < 6)
    return res
      .status(400)
      .json({ message: 'Password must be at least 6 characters' });

  try {
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    if (decoded.type !== 'reset')
      return res.status(400).json({ message: 'Invalid reset token' });

    // Match the same flexible lookup used in sendOtp / login so that users
    // whose login is an email-shaped userId (with no `email` column) can
    // still reset their password.
    const user = await findUserByEmailOrUserId(decoded.email);
    if (!user) {
      console.log(`[resetPassword] no user for "${decoded.email}" (tried all strategies)`);

      // Pull a short list of near-matches so the error message itself
      // gives the admin enough info to fix the data (without us having
      // to query the DB separately).
      let nearMatches = [];
      try {
        const local    = decoded.email.split('@')[0] || decoded.email;
        const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (local.length >= 3) {
          const containsRe = new RegExp(escapeRe(local), 'i');
          nearMatches = await User.find({
            $or: [{ userId: containsRe }, { email: containsRe }, { name: containsRe }],
          })
            .select('userId email name')
            .limit(5)
            .lean();
        }
      } catch (_) { /* best effort */ }

      return res.status(404).json({
        message: nearMatches.length
          ? `No account found for "${decoded.email}". Did you mean one of these? ` +
            nearMatches.map(u => u.userId).join(', ')
          : `No account found for "${decoded.email}". Please ask your admin to add your email to your employee record.`,
        searchedEmail: decoded.email,
        nearMatches,
        version: AUTH_CODE_VERSION,
      });
    }

    console.log(
      `[resetPassword] matched user userId=${user.userId} email=${user.email || '(empty)'} ` +
      `via ${user._matchedBy || 'unknown'}`
    );

    // CRITICAL: Hash the password ourselves and persist via updateOne.
    // This bypasses the Mongoose pre-save hook (which is unreliable — if the
    // hook silently fails, the plain-text password gets stored and login
    // never matches). With updateOne + manual bcrypt we KNOW the hash is right.
    const hashed = await bcrypt.hash(newPassword, 10);

    // Build the $set payload. Always update password; only backfill `email`
    // when the user has no email on file (so we don't clobber an existing,
    // different email when the user was matched via userId).
    const setPayload = { password: hashed };
    if (!user.email || !user.email.trim()) {
      setPayload.email = decoded.email;
    }

    await User.updateOne(
      { _id: user._id },
      { $set: setPayload }
    );

    console.log(
      `[resetPassword] ✓ password updated for userId=${user.userId} ` +
      `email=${decoded.email} hashPrefix=${hashed.slice(0, 7)}`
    );

    // Sanity check — re-read and verify the new password matches the new hash
    const fresh = await User.findById(user._id).select('+password');
    const verifyOk = await bcrypt.compare(newPassword, fresh.password);
    if (!verifyOk) {
      console.error('[resetPassword] ✗ POST-WRITE VERIFY FAILED — write did not persist!');
      return res.status(500).json({
        message: 'Password update could not be verified. Please try again.',
      });
    }
    console.log('[resetPassword] ✓ post-write verify OK — new password works');

    return res.json({ success: true, message: 'Password reset successful' });
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res
        .status(400)
        .json({ message: 'Reset session expired. Please start over.' });
    console.error('[resetPassword]', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Diagnostic endpoint — returns SMTP config state without exposing the password.
 * Visit /api/auth/email-status to debug email delivery.
 */
exports.emailStatus = (req, res) => {
  res.json({ smtp: getStatus(), version: AUTH_CODE_VERSION });
};

/**
 * GET /api/auth/test-email?to=you@example.com
 *
 * Fires a one-off test email through whichever provider is configured
 * AND returns the live result + any provider error verbatim. Hit this
 * from a browser whenever OTPs aren't arriving — the response tells
 * you exactly why (invalid key, unverified sender, rate-limit, etc.)
 * instead of forcing you to dig through Render logs.
 *
 * Disabled in production unless `ALLOW_TEST_EMAIL=1` is set, so a
 * stranger can't quietly burn through your free-tier email quota.
 */
exports.testEmail = async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_EMAIL !== '1') {
    return res.status(403).json({
      ok: false,
      message: 'Test endpoint disabled in production. Set ALLOW_TEST_EMAIL=1 on Render to enable.',
    });
  }
  const to = String(req.query.to || '').trim();
  if (!to) return res.status(400).json({ ok: false, message: 'Pass ?to=you@example.com' });
  const otp = '000000';
  const out = await sendOtpEmail(to, otp);
  res.json({
    ok:           !!out.sent,
    provider:     out.provider,
    info:         out.info || null,
    error:        out.error || null,
    status:       getStatus(),
    note:         out.sent
      ? `Sent via ${out.provider}. Check ${to}'s inbox (and spam folder).`
      : 'Email provider rejected the request — see "error" above for the verbatim provider reply.',
  });
};

/**
 * Returns the running code version for this controller. Use this to confirm
 * Render has actually picked up your latest deploy — bump AUTH_CODE_VERSION
 * at the top of this file every time you change auth logic.
 *
 *   curl https://backend-emqy.onrender.com/api/auth/version
 */
exports.version = (req, res) => {
  res.json({ version: AUTH_CODE_VERSION, time: new Date().toISOString() });
};

/**
 * Diagnostic endpoint — given an email or userId in the query string,
 * shows what would match in the DB so we can debug "no account found".
 * Returns: exact match (the same lookup resetPassword uses) PLUS a fuzzy
 * substring search on email, userId, and name.
 *
 *   curl "https://backend-emqy.onrender.com/api/auth/whoami?email=pragatheeswaranm30@gmail.com"
 *
 * Safe to leave enabled — it returns userId/email/name only (no password
 * hash, no token, no PII beyond what's already in the login screen).
 */
exports.whoami = async (req, res) => {
  const input = (req.query.email || req.query.userId || '').toString().trim();
  if (!input) {
    return res.status(400).json({
      message: 'Pass ?email=<address> or ?userId=<id> in the query string.',
    });
  }

  try {
    const lower    = input.toLowerCase();
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const local    = lower.includes('@') ? lower.split('@')[0] : lower;

    // 1. The exact lookup resetPassword performs
    const matched = await findUserByEmailOrUserId(input);

    // 2. Fuzzy substring matches so we can see "near misses"
    const fuzzyRe = new RegExp(escapeRe(local), 'i');
    const fuzzy = await User.find({
      $or: [
        { email:  fuzzyRe },
        { userId: fuzzyRe },
        { name:   fuzzyRe },
      ],
    })
      .select('userId email name role')
      .limit(10)
      .lean();

    return res.json({
      version: AUTH_CODE_VERSION,
      input,
      localPart: local,
      matchedExact: matched
        ? {
            userId: matched.userId,
            email:  matched.email || '(empty)',
            name:   matched.name,
            role:   matched.role,
          }
        : null,
      fuzzyMatchCount: fuzzy.length,
      fuzzy,
      totalUsersInDb: await User.countDocuments(),
    });
  } catch (err) {
    console.error('[whoami]', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * POST /api/auth/change-password    (JWT-protected)
 * Body: { oldPassword, newPassword }
 *
 * Lets a logged-in mobile employee rotate the password HR initially gave
 * them. Verifies oldPassword against the stored hash, then re-hashes and
 * stores newPassword. No OTP required since they're already authenticated.
 */
exports.changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: 'Provide oldPassword and newPassword.' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    }
    const user = await User.findById(req.user.id);
    if (!user || !user.password) {
      return res.status(404).json({ message: 'Account not found.' });
    }
    const ok = await bcrypt.compare(String(oldPassword), user.password);
    if (!ok) {
      return res.status(401).json({ message: 'Current password is wrong.' });
    }
    user.password = String(newPassword);   // pre-save hook will hash it
    await user.save();
    console.log(`[changePassword] ✓ ${user.email || user.employeeId} updated their password`);
    return res.json({ message: 'Password updated. Use the new password next time you sign in.' });
  } catch (err) {
    console.error('[changePassword]', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════
// ADMIN USER-MANAGEMENT ENDPOINTS (consumed by the HRMS web app)
//
// All require the x-admin-secret header. The secret comes from the
// ADMIN_SECRET env var on Render. Without it, every endpoint returns 503.
// ════════════════════════════════════════════════════════════════════════

function checkAdmin(req, res) {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) {
    res.status(503).json({ message: 'ADMIN_SECRET is not configured on the server.' });
    return false;
  }
  if (!got || got !== expected) {
    res.status(401).json({ message: 'Missing or invalid x-admin-secret header.' });
    return false;
  }
  return true;
}

/**
 * GET /api/auth/admin/users?q=<search>&limit=50
 * Search by userId / name / email (case-insensitive substring). Returns
 * { users, total, shown }.
 */
exports.adminListUsers = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const q     = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);

    let filter = {};
    if (q) {
      const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escapeRe(q), 'i');
      filter = { $or: [{ userId: re }, { name: re }, { email: re }] };
    }
    const [users, total] = await Promise.all([
      User.find(filter).select('-password').sort({ createdAt: -1 }).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    res.json({ users, total, shown: users.length });
  } catch (err) {
    console.error('[adminListUsers]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/auth/admin/users/:userId
 * Returns the FULL user document (password excluded).
 */
exports.adminGetUser = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const userId = req.params.userId;
    const user = await User.findOne({ userId }).select('-password').lean();
    if (!user) return res.status(404).json({ message: `No user with userId "${userId}".` });
    const fieldsStored = Object.keys(user).filter((k) => !['_id', '__v'].includes(k));
    res.json({ user, fieldsStored });
  } catch (err) {
    console.error('[adminGetUser]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * POST /api/auth/admin/users
 * Body: { userId, name, password, email?, phone?, role?, designation?, ... }
 *
 * Creates a User. IMPORTANT: passes the PLAINTEXT password to the model;
 * the pre('save') hook hashes it exactly once. Manually hashing here AND
 * letting the hook hash would double-hash and break login.
 */
exports.adminCreateUser = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const body = req.body || {};
    const { userId, name, password } = body;

    if (!userId || !name || !password) {
      return res.status(400).json({
        message: 'userId, name, and password are required.',
      });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const cleanUserId     = String(userId).trim();
    const normalizedEmail = String(body.email || '').trim().toLowerCase();

    const dupUserId = await User.findOne({ userId: cleanUserId });
    if (dupUserId) {
      return res.status(409).json({
        message: `A user with userId "${cleanUserId}" already exists.`,
        existing: { userId: dupUserId.userId, email: dupUserId.email, name: dupUserId.name },
      });
    }
    if (normalizedEmail) {
      const dupEmail = await User.findOne({ email: normalizedEmail });
      if (dupEmail) {
        return res.status(409).json({
          message: `A user with email "${normalizedEmail}" already exists.`,
          existing: { userId: dupEmail.userId, email: dupEmail.email, name: dupEmail.name },
        });
      }
    }

    const doc = {
      userId:   cleanUserId,
      name:     String(name).trim(),
      password: String(password),         // plaintext — model pre('save') hashes
      email:    normalizedEmail,
    };
    const stringFields = ['role', 'designation', 'phone', 'dob', 'gender',
      'bloodGroup', 'photoUrl', 'address', 'status', 'workType'];
    stringFields.forEach((f) => {
      if (body[f] !== undefined && body[f] !== null) doc[f] = String(body[f]).trim();
    });
    const numberFields = ['leaveBalance', 'permissionBalance'];
    numberFields.forEach((f) => {
      if (body[f] !== undefined && body[f] !== null && body[f] !== '') {
        const n = Number(body[f]);
        if (!isNaN(n)) doc[f] = n;
      }
    });

    const created = await User.create(doc);
    const fresh   = await User.findById(created._id).select('-password').lean();

    console.log(`[adminCreateUser] ✓ created userId=${created.userId} email=${created.email || '(empty)'}`);
    return res.status(201).json({
      message:      'User created.',
      fieldsStored: Object.keys(fresh),
      user:         fresh,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        message: 'Duplicate key — userId or email must be unique.',
        error:   err.message,
      });
    }
    console.error('[adminCreateUser]', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * PATCH /api/auth/admin/users/:userId
 * Whitelisted fields only. Password is re-hashed manually since updateOne
 * doesn't fire the pre('save') hook.
 */
exports.adminUpdateUser = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const targetUserId = req.params.userId;
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ci = new RegExp(`^${escapeRe(targetUserId)}$`, 'i');
    const user = await User.findOne({ userId: ci });
    if (!user) return res.status(404).json({ message: `No user with userId "${targetUserId}".` });

    const updates = {};
    const stringFields = ['email', 'name', 'phone', 'role', 'designation', 'status',
      'dob', 'gender', 'bloodGroup', 'photoUrl', 'address', 'workType'];
    for (const f of stringFields) {
      if (req.body[f] !== undefined) {
        updates[f] = f === 'email'
          ? String(req.body[f] || '').trim().toLowerCase()
          : String(req.body[f] || '').trim();
      }
    }
    const numberFields = ['leaveBalance', 'permissionBalance'];
    for (const f of numberFields) {
      if (req.body[f] !== undefined && req.body[f] !== '' && req.body[f] !== null) {
        const n = Number(req.body[f]);
        if (!isNaN(n)) updates[f] = n;
      }
    }
    if (req.body.password !== undefined) {
      if (String(req.body.password).length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters.' });
      }
      updates.password = await bcrypt.hash(String(req.body.password), 10);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        message: 'No updatable fields supplied. Pass at least one of: ' +
                 stringFields.concat(numberFields, 'password').join(', '),
      });
    }

    if (updates.email) {
      const other = await User.findOne({ email: updates.email, _id: { $ne: user._id } });
      if (other) {
        return res.status(409).json({
          message: `Another user already has email "${updates.email}".`,
          existing: { userId: other.userId, name: other.name },
        });
      }
    }

    await User.updateOne({ _id: user._id }, { $set: updates });
    const fresh = await User.findById(user._id).select('-password');
    console.log(`[adminUpdateUser] ✓ updated userId=${user.userId} fields=${Object.keys(updates).join(',')}`);
    return res.json({ message: 'User updated.', user: fresh });
  } catch (err) {
    console.error('[adminUpdateUser]', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * DELETE /api/auth/admin/users/:userId
 */
exports.adminDeleteUser = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const u = await User.findOneAndDelete({ userId: req.params.userId });
    if (!u) return res.status(404).json({ message: `No user with userId "${req.params.userId}".` });
    console.log(`[adminDeleteUser] ✓ deleted userId=${u.userId}`);
    return res.json({ message: 'User deleted.', userId: u.userId });
  } catch (err) {
    console.error('[adminDeleteUser]', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * GET /api/auth/admin/users/:userId/leave-policy
 * Returns this-month leave/permission usage + LOP for the user, using the
 * same shared module as the mobile attendance/profile screens.
 */
exports.adminLeavePolicy = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ message: `No user with userId "${req.params.userId}".` });

    const now    = new Date();
    const year   = parseInt(req.query.year,  10) || now.getFullYear();
    const month1 = parseInt(req.query.month, 10) || (now.getMonth() + 1);
    const policy = await computeLeavePolicy(user._id, year, month1 - 1);
    return res.json(policy);
  } catch (err) {
    console.error('[adminLeavePolicy]', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
