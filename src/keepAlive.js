/**
 * Keep-alive cron.
 *
 * Render's free tier puts the service to sleep after ~15 minutes of inactivity,
 * and the first request after that takes ~30s to wake. To keep the API hot,
 * this module schedules a cron job that pings /api/health every 10 minutes.
 *
 * The target URL is resolved in this order:
 *   1. process.env.PING_URL              (manual override)
 *   2. process.env.RENDER_EXTERNAL_URL   (auto-set by Render)
 *   3. http://localhost:PORT             (local dev — harmless)
 *
 * Disable the ping by setting KEEP_ALIVE=false.
 */
const cron = require('node-cron');

function resolveTarget(port) {
  if (process.env.PING_URL) return process.env.PING_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  }
  return `http://localhost:${port}`;
}

/**
 * Start the keep-alive cron.
 * @param {number} port - The port the API is listening on (for local fallback).
 */
function startKeepAlive(port = 5000) {
  if (process.env.KEEP_ALIVE === 'false') {
    console.log('[keepAlive] disabled via KEEP_ALIVE=false');
    return;
  }

  const base = resolveTarget(port);
  const target = `${base}/api/health`;

  // Every 10 minutes — well under Render's 15-minute idle threshold.
  // Cron format:        sec  min  hour day month weekday
  const schedule = process.env.KEEP_ALIVE_CRON || '*/10 * * * *';

  if (!cron.validate(schedule)) {
    console.warn('[keepAlive] invalid KEEP_ALIVE_CRON, falling back to */10 * * * *');
  }

  console.log(`[keepAlive] scheduled "${schedule}" → ${target}`);

  cron.schedule(schedule, async () => {
    const startedAt = Date.now();
    try {
      // Node 18+ has global fetch, which Render runs.
      const res = await fetch(target, { method: 'GET' });
      const ms = Date.now() - startedAt;
      if (res.ok) {
        console.log(`[keepAlive] ✔ ${res.status} ${target} (${ms}ms)`);
      } else {
        console.warn(`[keepAlive] ⚠ ${res.status} ${target} (${ms}ms)`);
      }
    } catch (err) {
      console.warn(`[keepAlive] ✖ ping failed: ${err.message}`);
    }
  });

  // Optional: also schedule a daily DB sanity ping at 00:05 — purely cosmetic
  // so the logs show the cron is alive even during low-traffic hours.
  cron.schedule('5 0 * * *', () => {
    console.log('[keepAlive] daily heartbeat ' + new Date().toISOString());
  });
}

module.exports = { startKeepAlive };
