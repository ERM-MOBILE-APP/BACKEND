/**
 * Keep-alive self-pinger (v2 — hardened Jun 2026).
 *
 * Render's free tier suspends a web service after ~15 min of zero
 * inbound HTTP traffic. To stay warm 24/7 the dyno must receive an
 * external HTTP request more often than that. This module makes the
 * service ping ITSELF via its public Render URL.
 *
 *  CRITICAL: localhost pings do NOT count as external traffic. Render
 *  only resets the idle timer on requests that hit the public router.
 *  v1 of this file silently fell back to http://localhost when
 *  RENDER_EXTERNAL_URL was missing — those pings logged 200 but the
 *  dyno still slept. v2 refuses the localhost fallback in production
 *  and warns loudly.
 *
 * Resilience layers added in v2:
 *   1. 10-min interval (was 14) — extra safety margin below the 15-min
 *      Render sleep threshold.
 *   2. Quick retry: if a ping fails (network blip), retry after 30 s
 *      instead of waiting the full 10 min. Two consecutive failures
 *      log loudly so ops sees the dyno is at risk of sleeping.
 *   3. AbortController with 20-s timeout per ping — a hanging request
 *      can't pin the timer.
 *   4. Boot-time validation: first ping fires 30 s after boot and the
 *      response code is loudly logged so a misconfigured
 *      RENDER_EXTERNAL_URL is obvious on first deploy.
 *
 * Long-term recommendation: configure an EXTERNAL watchdog
 * (cron-job.org, UptimeRobot, GitHub Actions cron) that hits
 * /api/_health on all three backends every 5 min. Internal self-ping
 * has a fundamental limitation — once the dyno sleeps, nothing inside
 * it can wake itself. External pings are the only true guarantee.
 */
const PING_PATH        = '/api/_health';
const PING_INTERVAL_MS  = 10 * 60 * 1000;   // 10 min (was 14)
const RETRY_DELAY_MS    =  30 * 1000;       // retry once after 30 s on failure
const REQUEST_TIMEOUT_MS = 20 * 1000;       // 20 s per ping

function startKeepAlive(port) {
  const explicit = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || '').trim();
  const isProd   = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
  let url        = explicit;

  if (!url) {
    if (isProd) {
      console.warn('[keepAlive] ⚠ RENDER_EXTERNAL_URL / KEEP_ALIVE_URL not set in production.');
      console.warn('[keepAlive] ⚠ Self-ping DISABLED — dyno will sleep after ~15 min idle.');
      console.warn('[keepAlive] ⚠ Fix: set KEEP_ALIVE_URL=https://<your-render-subdomain>.onrender.com on Render → Environment.');
      return;
    }
    // Dev only: fall back to localhost so logs aren't noisy. Localhost
    // pings won't keep Render warm, but in dev there's no Render either.
    url = port ? `http://localhost:${port}` : '';
    if (!url) {
      console.log('[keepAlive] No URL + no port → self-ping disabled (dev mode).');
      return;
    }
  }

  const target = url.replace(/\/+$/, '') + PING_PATH;
  let consecutiveFailures = 0;

  const pingOnce = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(target, { signal: ctrl.signal });
      if (res.ok) {
        if (consecutiveFailures > 0) {
          console.log(`[keepAlive] ✓ recovered after ${consecutiveFailures} failure(s)`);
        }
        consecutiveFailures = 0;
        console.log(`[keepAlive] ping ${target} → ${res.status} @ ${new Date().toISOString()}`);
        return true;
      }
      console.warn(`[keepAlive] ping returned ${res.status} — treating as failure`);
      consecutiveFailures++;
      return false;
    } catch (err) {
      consecutiveFailures++;
      console.warn(`[keepAlive] ping failed (#${consecutiveFailures}):`, err.message);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const ping = async () => {
    const ok = await pingOnce();
    if (!ok) {
      // Single retry 30 s later. Two consecutive failures = risk of
      // sleep within the next 10 min, so log a loud warning.
      setTimeout(async () => {
        const ok2 = await pingOnce();
        if (!ok2 && consecutiveFailures >= 2) {
          console.error('[keepAlive] ⚠⚠ TWO consecutive failures — dyno may sleep at next idle threshold!');
        }
      }, RETRY_DELAY_MS);
    }
  };

  // First ping 30 s after boot — gives mongoose + routes time to settle.
  setTimeout(() => { ping(); setInterval(ping, PING_INTERVAL_MS); }, 30_000);
  console.log(`[keepAlive] ✓ self-ping every ${PING_INTERVAL_MS / 60000} min → ${target}`);
}

const start = startKeepAlive;
module.exports = { start, startKeepAlive };
