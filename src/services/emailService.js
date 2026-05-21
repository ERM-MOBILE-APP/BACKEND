/**
 * Email service for sending OTPs and notifications.
 * Uses SMTP via nodemailer (Gmail-friendly).
 *
 * ENV VARS:
 *   SMTP_HOST       e.g. smtp.gmail.com
 *   SMTP_PORT       e.g. 465 (secure) or 587 (STARTTLS)
 *   SMTP_USER       sender Gmail address
 *   SMTP_PASS       Gmail App Password (16 chars, NO spaces — NOT regular password)
 *   SMTP_FROM       from-address (defaults to SMTP_USER)
 *   SMTP_FROM_NAME  display name (defaults to "Tesco ERM")
 *
 * Common Gmail SMTP gotchas:
 *  1) Must use App Password (16 chars), not regular password — needs 2-Step Verification ON.
 *  2) Strip ALL spaces from the App Password before saving.
 *  3) Render free tier blocks outbound port 25; port 465 + secure:true is most reliable.
 */

const nodemailer = require('nodemailer');

let transporter = null;
let lastVerifyError = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, ''); // strip spaces just in case

  if (!host || !user || !pass) {
    console.warn(
      '[emailService] SMTP_HOST / SMTP_USER / SMTP_PASS not set. Falling back to console-only logging.'
    );
    return null;
  }

  const secure = port === 465;
  console.log(
    `[emailService] init transporter → host=${host} port=${port} secure=${secure} user=${user}`
  );

  transporter = nodemailer.createTransport({
    host,
    port,
    secure, // true for 465, false for 587 (STARTTLS)
    auth: { user, pass },
    tls: {
      // Render's outbound TLS sometimes needs this relaxed
      rejectUnauthorized: false,
    },
    connectionTimeout: 15000,
    socketTimeout: 20000,
  });

  transporter.verify((err) => {
    if (err) {
      lastVerifyError = err;
      console.error('[emailService] SMTP verify FAILED:', err.message);
      console.error('   → check: 2-Step Verification enabled? App Password correct? Port 465 + secure:true recommended.');
    } else {
      lastVerifyError = null;
      console.log(`[emailService] SMTP ready ✓ — sending via ${host}:${port} as ${user}`);
    }
  });

  return transporter;
}

/**
 * Send OTP email with branded HTML template.
 * Returns { sent: boolean, info?: any, error?: string }
 */
async function sendOtpEmail(toEmail, otp) {
  const tx = getTransporter();
  if (!tx) {
    console.log(`[emailService] (mock) OTP for ${toEmail} = ${otp}`);
    return { sent: false, error: 'SMTP not configured (check env vars)' };
  }

  const fromName = (process.env.SMTP_FROM_NAME || 'Tesco ERM').trim();
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width:520px; margin:0 auto; padding:32px 24px; background:#f6f9f5; border-radius:12px;">
    <div style="text-align:center; padding-bottom:18px;">
      <div style="display:inline-block; padding:10px 22px; background:#2E8C2C; border-radius:10px;">
        <span style="color:#fff; font-size:22px; font-weight:800; letter-spacing:1.5px;">TESCO</span>
        <div style="color:#dff5d8; font-size:10px; letter-spacing:4px; margin-top:2px;">ERM</div>
      </div>
    </div>

    <div style="background:#ffffff; border-radius:10px; padding:28px 24px; box-shadow:0 4px 12px rgba(0,0,0,0.04);">
      <h2 style="margin:0 0 8px; color:#1A1A1A; font-size:20px;">Password Reset OTP</h2>
      <p style="margin:0 0 22px; color:#6b6b6b; font-size:14px; line-height:1.5;">
        Use the One-Time Password below to verify your identity and set a new password.
        This code is valid for <b>10 minutes</b>.
      </p>

      <div style="text-align:center; margin:18px 0 22px;">
        <div style="display:inline-block; padding:14px 28px; background:#F4FBF3; border:1.5px dashed #3FAE3B; border-radius:10px;">
          <span style="font-size:30px; font-weight:800; letter-spacing:8px; color:#1F6A1E;">${otp}</span>
        </div>
      </div>

      <p style="margin:0 0 6px; color:#6b6b6b; font-size:12.5px;">
        If you didn't request this, you can safely ignore this email.
      </p>
      <p style="margin:0; color:#9a9a9a; font-size:11.5px;">
        For security, never share this code with anyone — including Tesco ERM staff.
      </p>
    </div>

    <p style="text-align:center; margin:18px 0 0; color:#9a9a9a; font-size:11px;">
      © ${new Date().getFullYear()} ${fromName}. Sent automatically — please do not reply.
    </p>
  </div>
  `;

  try {
    const info = await tx.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to: toEmail,
      subject: `Your Tesco ERM password reset code: ${otp}`,
      text: `Your Tesco ERM password reset OTP is ${otp}. It is valid for 10 minutes.`,
      html,
    });
    console.log(`[emailService] ✓ OTP sent to ${toEmail} — messageId: ${info.messageId} response: ${info.response}`);
    return { sent: true, info };
  } catch (err) {
    console.error('[emailService] ✗ send FAILED:', err.message);
    console.error('   stack:', err.stack);
    return { sent: false, error: err.message };
  }
}

function getStatus() {
  return {
    hasTransporter: !!transporter,
    lastVerifyError: lastVerifyError ? lastVerifyError.message : null,
    config: {
      host: process.env.SMTP_HOST || null,
      port: Number(process.env.SMTP_PORT || 465),
      user: process.env.SMTP_USER || null,
      hasPass: !!process.env.SMTP_PASS,
    },
  };
}

module.exports = { sendOtpEmail, getStatus };
