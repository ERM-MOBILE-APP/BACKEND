/**
 * Email service — sends OTPs via Resend (HTTPS) or SMTP (Gmail).
 *
 * On Render free tier, outbound SMTP to Gmail (ports 465/587) is often
 * blocked or throttled, causing connection timeouts. Resend uses an
 * HTTPS API on port 443 which is always allowed, so we prefer it when
 * RESEND_API_KEY is set.
 *
 * Priority:
 *   1. Resend         (if RESEND_API_KEY set)
 *   2. SMTP/Gmail     (if SMTP_HOST/USER/PASS set)
 *   3. Console mock   (logs OTP to backend logs only)
 *
 * RESEND ENV VARS:
 *   RESEND_API_KEY    – API key from https://resend.com/api-keys
 *   RESEND_FROM       – verified sender, e.g. "Tesco ERM <onboarding@resend.dev>"
 *                       (use onboarding@resend.dev for testing — works
 *                        out of the box, no domain verification needed)
 *
 * SMTP ENV VARS (fallback):
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 *   SMTP_FROM (optional) / SMTP_FROM_NAME (optional)
 */

const nodemailer = require('nodemailer');
let Resend;
try {
  Resend = require('resend').Resend;
} catch (_) {
  Resend = null; // resend not installed yet
}

let smtpTransporter = null;
let resendClient = null;
let lastVerifyError = null;
let provider = 'none';

// ---------- Resend setup ----------
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  if (!Resend) {
    console.warn('[emailService] RESEND_API_KEY set but `resend` package not installed. Run: npm install resend');
    return null;
  }
  resendClient = new Resend(process.env.RESEND_API_KEY);
  provider = 'resend';
  console.log('[emailService] Resend HTTPS provider initialized ✓');
  return resendClient;
}

// ---------- SMTP setup ----------
function getSmtp() {
  if (smtpTransporter) return smtpTransporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');

  if (!host || !user || !pass) return null;

  const secure = port === 465;
  console.log(`[emailService] SMTP transporter → host=${host} port=${port} secure=${secure} user=${user}`);

  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    socketTimeout: 20000,
  });

  smtpTransporter.verify((err) => {
    if (err) {
      lastVerifyError = err;
      console.error('[emailService] SMTP verify FAILED:', err.message);
    } else {
      lastVerifyError = null;
      console.log(`[emailService] SMTP ready ✓ — sending via ${host}:${port}`);
    }
  });

  if (provider === 'none') provider = 'smtp';
  return smtpTransporter;
}

// ---------- HTML template (shared) ----------
function buildHtml(otp, fromName) {
  return `
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
        For security, never share this code with anyone — including ${fromName} staff.
      </p>
    </div>

    <p style="text-align:center; margin:18px 0 0; color:#9a9a9a; font-size:11px;">
      © ${new Date().getFullYear()} ${fromName}. Sent automatically — please do not reply.
    </p>
  </div>
  `;
}

// ---------- Main send function ----------
async function sendOtpEmail(toEmail, otp) {
  const fromName = (process.env.SMTP_FROM_NAME || 'Tesco ERM').trim();
  const html = buildHtml(otp, fromName);
  const subject = `Your Tesco ERM password reset code: ${otp}`;
  const text = `Your Tesco ERM password reset OTP is ${otp}. It is valid for 10 minutes.`;

  // ----- Try Resend first (HTTPS, works on Render free tier) -----
  const resend = getResend();
  if (resend) {
    try {
      const from = process.env.RESEND_FROM || `${fromName} <onboarding@resend.dev>`;
      const { data, error } = await resend.emails.send({
        from, to: toEmail, subject, html, text,
      });
      if (error) {
        console.error('[emailService] Resend send FAILED:', error.message || error);
        return { sent: false, error: `Resend: ${error.message || JSON.stringify(error)}`, provider: 'resend' };
      }
      console.log(`[emailService] ✓ Resend sent to ${toEmail} — id: ${data?.id}`);
      return { sent: true, info: data, provider: 'resend' };
    } catch (err) {
      console.error('[emailService] Resend exception:', err.message);
      // fall through to SMTP fallback
    }
  }

  // ----- Fall back to SMTP -----
  const tx = getSmtp();
  if (!tx) {
    console.log(`[emailService] (mock) no provider configured — OTP for ${toEmail} = ${otp}`);
    return {
      sent: false,
      error: 'No email provider configured (RESEND_API_KEY or SMTP_HOST/USER/PASS)',
      provider: 'none',
    };
  }

  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    const info = await tx.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to: toEmail, subject, text, html,
    });
    console.log(`[emailService] ✓ SMTP sent to ${toEmail} — messageId: ${info.messageId}`);
    return { sent: true, info, provider: 'smtp' };
  } catch (err) {
    console.error('[emailService] ✗ SMTP send FAILED:', err.message);
    return { sent: false, error: err.message, provider: 'smtp' };
  }
}

function getStatus() {
  return {
    activeProvider: provider,
    resend: {
      configured: !!process.env.RESEND_API_KEY,
      hasFrom: !!process.env.RESEND_FROM,
    },
    smtp: {
      hasTransporter: !!smtpTransporter,
      lastVerifyError: lastVerifyError ? lastVerifyError.message : null,
      config: {
        host: process.env.SMTP_HOST || null,
        port: Number(process.env.SMTP_PORT || 465),
        user: process.env.SMTP_USER || null,
        hasPass: !!process.env.SMTP_PASS,
      },
    },
  };
}

module.exports = { sendOtpEmail, getStatus };
