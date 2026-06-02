/**
 * Email service — sends OTPs via Twilio SendGrid (HTTPS API).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY SENDGRID
 * ─────────────────────────────────────────────────────────────────────────
 * Render free tier BLOCKS outbound SMTP (ports 25, 465, 587), so we must
 * use an HTTPS-based provider on port 443. SendGrid (owned by Twilio) gives
 * 100 free emails/day on a verified single sender — enough for password
 * resets on a small team — and works out of the box on Render.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SETUP (one-time)
 * ─────────────────────────────────────────────────────────────────────────
 *  1. Create an account at https://signup.sendgrid.com
 *  2. Verify a sender:
 *       Settings → Sender Authentication → Verify a Single Sender
 *       (e.g. tescodigitalproject2026@gmail.com)
 *  3. Create an API key:
 *       Settings → API Keys → Create API Key → Full Access
 *  4. On Render → Environment, set:
 *       SENDGRID_API_KEY    = SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *       SENDGRID_FROM       = tescodigitalproject2026@gmail.com   (verified sender)
 *       SENDGRID_FROM_NAME  = Tesco ERM                           (optional)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BEHAVIOR
 * ─────────────────────────────────────────────────────────────────────────
 *  - If SendGrid env vars are set    → email goes through SendGrid.
 *  - If SendGrid env vars are missing → falls back to console-mock so dev
 *                                       work can continue without keys
 *                                       (OTP printed to server logs).
 */

const fs   = require('fs');
const path = require('path');

let provider = 'none';

// ─── Logo (read once on startup) ─────────────────────────────────────────────
// Logo lives in backend/src/assets/logo.png (copied from frontend/assets/logo.png)
// We embed it as an inline CID attachment so email clients (Gmail, Outlook,
// Apple Mail) render it as a proper image instead of stripping a data URI.
// The CID equals the filename so the same <img src="cid:logo.png"> tag works
// across every provider we might add later.
const LOGO_CID  = 'logo.png';
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');
let   LOGO_BUFFER = null;
let   LOGO_BASE64 = null;
try {
  LOGO_BUFFER = fs.readFileSync(LOGO_PATH);
  LOGO_BASE64 = LOGO_BUFFER.toString('base64');
  console.log(`[emailService] Logo loaded (${LOGO_BUFFER.length} bytes) from ${LOGO_PATH}`);
} catch (err) {
  console.warn(`[emailService] Logo NOT found at ${LOGO_PATH} — email will render without logo. (${err.message})`);
}

// ─── SendGrid (HTTPS — works on Render free tier) ───────────────────────────
function hasSendGrid() {
  return !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM);
}

async function sendViaSendGrid(toEmail, subject, html, text) {
  const apiKey    = process.env.SENDGRID_API_KEY;
  const fromEmail = (process.env.SENDGRID_FROM      || '').trim();
  const fromName  = (process.env.SENDGRID_FROM_NAME || 'Tesco ERM').trim();

  const payload = {
    personalizations: [{ to: [{ email: toEmail }] }],
    from:    { email: fromEmail, name: fromName },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html',  value: html },
    ],
  };

  // Use global fetch (Node 18+) — no extra dependency needed.
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  // SendGrid returns 202 Accepted with an empty body on success.
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.errors && j.errors.length)
        errMsg = j.errors.map((e) => e.message).join('; ');
      else errMsg = JSON.stringify(j);
    } catch (_) {}
    // Surface the HTTP status alongside the SendGrid error message so
    // ops can quickly tell whether the key is dead (401), the sender
    // is unverified (403), or the request itself is bad (400).
    const err = new Error(`SendGrid (HTTP ${res.status}): ${errMsg}`);
    err.status = res.status;
    throw err;
  }

  return { messageId: res.headers.get('x-message-id') || 'queued' };
}

// ─── Brevo / Sendinblue fallback (HTTPS — also Render-free-tier safe) ──────
// Brevo gives 300 free emails/day. Set BREVO_API_KEY + BREVO_FROM on Render
// to enable. When SendGrid returns a 4xx (dead key, unverified sender, etc.)
// we automatically retry the same OTP through Brevo so users aren't blocked
// while ops rotates the SendGrid credentials.
function hasBrevo() {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_FROM);
}

async function sendViaBrevo(toEmail, subject, html, text) {
  const apiKey    = process.env.BREVO_API_KEY;
  const fromEmail = (process.env.BREVO_FROM      || '').trim();
  const fromName  = (process.env.BREVO_FROM_NAME || 'Tesco ERM').trim();
  const payload = {
    sender:      { email: fromEmail, name: fromName },
    to:          [{ email: toEmail }],
    subject,
    htmlContent: html,
    textContent: text,
  };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept':       'application/json',
      'api-key':      apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      errMsg = j?.message || JSON.stringify(j);
    } catch (_) {}
    const err = new Error(`Brevo (HTTP ${res.status}): ${errMsg}`);
    err.status = res.status;
    throw err;
  }
  let body = {};
  try { body = await res.json(); } catch (_) {}
  return { messageId: body?.messageId || 'queued' };
}

// ─── HTML template ───────────────────────────────────────────────────────────
function buildHtml(otp, fromName) {
  const logoSrc = LOGO_BASE64 ? `cid:${LOGO_CID}` : '';
  const logoImg = logoSrc
    ? `<img src="${logoSrc}" alt="${fromName}" width="180" style="display:block; max-width:180px; height:auto; margin:0 auto;" />`
    : '';

  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width:520px; margin:0 auto; padding:32px 24px; background:#f6f9f5; border-radius:12px;">
    <div style="text-align:center; padding-bottom:18px;">
      
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

// ─── Main send function ───────────────────────────────────────────────────────
//
// Order of attempt:
//   1. SendGrid  (preferred — 100/day free)
//   2. Brevo     (fallback when SendGrid returns a 4xx auth/sender error)
//   3. Console-mock (dev — OTP printed to logs, response still flags
//                    sent=false so the client surfaces an alert)
//
// We auto-fallback only on 4xx because a 5xx from SendGrid is a transient
// outage and retrying through a different provider would risk
// double-delivery once SendGrid recovers.
async function sendOtpEmail(toEmail, otp) {
  const fromName = (process.env.SENDGRID_FROM_NAME || process.env.BREVO_FROM_NAME || 'Tesco ERM').trim();
  const html     = buildHtml(otp, fromName);
  const subject  = `Your Tesco ERM password reset code: ${otp}`;
  const text     = `Your Tesco ERM OTP is ${otp}. Valid for 10 minutes. Do not share this code.`;

  // Force-Brevo escape hatch (Jun 2026). Set DISABLE_SENDGRID=1 on
  // Render to skip SendGrid entirely while ops debugs the key/sender
  // verification — OTPs keep flowing through Brevo without a code
  // change. Setting EMAIL_PROVIDER=brevo has the same effect.
  const skipSendGrid =
    /^(1|true|yes)$/i.test(process.env.DISABLE_SENDGRID || '') ||
    /^brevo$/i.test(process.env.EMAIL_PROVIDER || '');

  let sgError = null;
  if (hasSendGrid() && !skipSendGrid) {
    try {
      provider = 'sendgrid';
      const data = await sendViaSendGrid(toEmail, subject, html, text);
      console.log(`[emailService] ✓ SendGrid → ${toEmail} (messageId: ${data?.messageId})`);
      return { sent: true, info: data, provider: 'sendgrid' };
    } catch (err) {
      sgError = err;
      console.error('[emailService] SendGrid FAILED:', err.message);
      // Updated Jun 2026 — fall through to Brevo on ANY error, not just
      // 4xx. A stale-key 401 (the most common cause) was already handled
      // but operators were still seeing real outages slip through when
      // SendGrid returned 5xx during a rotation. Always trying Brevo is
      // strictly safer: it only sends when SendGrid clearly didn't,
      // and the worst case is a duplicate email if SendGrid recovers
      // mid-request (which we accept over a missed OTP).
    }
  } else if (skipSendGrid) {
    console.log('[emailService] Skipping SendGrid (DISABLE_SENDGRID / EMAIL_PROVIDER=brevo).');
  }

  if (hasBrevo()) {
    try {
      provider = 'brevo';
      const data = await sendViaBrevo(toEmail, subject, html, text);
      console.log(`[emailService] ✓ Brevo (fallback) → ${toEmail} (messageId: ${data?.messageId})`);
      return { sent: true, info: data, provider: 'brevo' };
    } catch (err) {
      console.error('[emailService] Brevo FAILED:', err.message);
      const combined = sgError
        ? `Both providers failed — SendGrid: ${sgError.message} | Brevo: ${err.message}`
        : `Brevo: ${err.message}`;
      return { sent: false, error: combined, provider: 'brevo' };
    }
  }

  // No provider succeeded. Log the OTP so dev can still test, and bubble
  // a useful error message back to the controller (which converts it
  // into the alert the user sees). The hint expands to include the
  // "env var didn't redeploy" gotcha that bites people who rotated
  // their SendGrid key but forgot Render needs a redeploy / manual
  // restart to pick up the new value.
  console.error(
    `[emailService] No email provider succeeded — OTP for ${toEmail} = ${otp}\n` +
    `  SendGrid error: ${sgError ? sgError.message : 'not configured'}\n` +
    '  Recovery steps:\n' +
    '   1. On Render → Environment, confirm SENDGRID_API_KEY matches the value\n' +
    '      from your SendGrid dashboard exactly (no leading "Bearer ", no spaces).\n' +
    '   2. Save the env var AND trigger a redeploy — Render does NOT hot-reload\n' +
    '      env changes; the running container still uses the old value otherwise.\n' +
    '   3. Verify the sender at SendGrid -> Settings -> Sender Authentication.\n' +
    '   4. As a backup, configure BREVO_API_KEY + BREVO_FROM and (optionally)\n' +
    '      set DISABLE_SENDGRID=1 to route every OTP through Brevo.'
  );
  return {
    sent:  false,
    error: sgError
      ? `Couldn't send OTP. ${sgError.message}. Check that SENDGRID_API_KEY on Render matches your dashboard, then redeploy (env changes don't hot-reload). Configure BREVO_API_KEY for an automatic fallback.`
      : 'Email provider not configured. Set SENDGRID_API_KEY + SENDGRID_FROM (or BREVO_API_KEY + BREVO_FROM) on Render and redeploy.',
    provider: 'none',
  };
}

// ___ Status endpoint __________________________________________________________
function getStatus() {
  return {
    activeProvider: provider,
    sendgrid: {
      configured: hasSendGrid(),
      hasApiKey:  !!process.env.SENDGRID_API_KEY,
      hasFrom:    !!process.env.SENDGRID_FROM,
      from:       process.env.SENDGRID_FROM || null,
      fromName:   process.env.SENDGRID_FROM_NAME || null,
    },
    brevo: {
      configured: hasBrevo(),
      hasApiKey:  !!process.env.BREVO_API_KEY,
      hasFrom:    !!process.env.BREVO_FROM,
      from:       process.env.BREVO_FROM || null,
      fromName:   process.env.BREVO_FROM_NAME || null,
    },
  };
}

module.exports = { sendOtpEmail, getStatus };
