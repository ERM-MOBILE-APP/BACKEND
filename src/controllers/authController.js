const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sendOtpEmail, getStatus } = require('../services/emailService');

// In-memory OTP store: { email: { otp, expiresAt, attempts } }
// Replace with Redis or DB in production.
const otpStore = new Map();
const MAX_ATTEMPTS = 5;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 min

exports.login = async (req, res) => {
  const { userId, password } = req.body;
  try {
    // userId field may contain either a userId string or an email address.
    // Use case-insensitive regex for email so users are found regardless of
    // how their email was originally stored (mixed-case vs lowercase).
    const emailNormalized = (userId || '').toLowerCase().trim();
    const user = await User.findOne({
      $or: [
        { userId: userId },
        { email: { $regex: new RegExp(`^${emailNormalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
      ],
    });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { name: user.name, userId: user.userId, role: user.role } });
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

    // Soft check — log if no user, but still send OTP (you might want to
    // tighten this later). Useful when User records lack email field.
    const user = await User.findOne({ email: normalized });
    if (!user) {
      console.warn(`[sendOtp] no User record for ${normalized} — sending OTP anyway`);
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + OTP_TTL_MS;
    otpStore.set(normalized, { otp, expiresAt, attempts: 0 });

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
    const reason = result.error || 'Unknown SMTP error';
    const hint = /not configured/i.test(reason)
      ? 'SMTP environment variables are missing on the server. The admin must add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS on Render → Environment.'
      : /invalid login|535|auth/i.test(reason)
      ? 'SMTP credentials are wrong. Regenerate the Gmail App Password at myaccount.google.com/apppasswords and update SMTP_PASS on Render.'
      : /timeout|ETIMEDOUT|ECONN/i.test(reason)
      ? 'SMTP host is unreachable. Check SMTP_HOST/SMTP_PORT — try port 465 with SSL.'
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

    // Use case-insensitive regex so users are found even if their email was
    // stored in mixed-case in the database.
    const emailPattern = new RegExp(
      `^${decoded.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'i'
    );
    const user = await User.findOne({ email: emailPattern });
    if (!user)
      return res.status(404).json({
        message: 'No account found for this email. Cannot reset password.',
      });

    user.password = newPassword; // pre-save hook will hash
    await user.save();

    // Also normalise the stored email to lowercase so future lookups are consistent
    if (user.email !== decoded.email) {
      await User.updateOne({ _id: user._id }, { $set: { email: decoded.email } });
    }

    console.log(`[resetPassword] ✓ password updated for ${decoded.email}`);
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
  res.json({ smtp: getStatus() });
};
