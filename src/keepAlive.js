/**
 * Keep-alive self-pinger.
 *
 * Render's free tier suspends a web service after ~15 min of zero
 * inbound HTTP traffic and takes 30-60 s to spin back up. To prevent
 * the cold-start hitting the first morning user, this pings the
 * service's own /api/_health every 14 min so the dyno stays warm 24/7.
 *
 * URL resolution order:
 *   1. RENDER_EXTERNAL_URL (auto-set by Render)
 *   2. KEEP_ALIVE_URL      (manual override)
 *   3. http://localhost:<port>  (passed in by app.listen callback)
 */
const PING_PATH       = '/api/_health';
const PING_INTERVAL_MS = 14 * 60 * 1000;

function startKeepAlive(port) {
  const explicit = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || '').trim();
  const url = explicit || (port ? `http://localhost:${port}` : '');
  if (!url) {
    console.log('[keepAlive] No RENDER_EXTERNAL_URL / KEEP_ALIVE_URL / port — self-ping disabled.');
    return;
  }
  const target = url.replace(/\/$/, '') + PING_PATH;
  const ping = async () => {
    try {
      const res = await fetch(target);
      console.log(`[keepAlive] ping ${target} -> ${res.status} @ ${new Date().toISOString()}`);
    } catch (err) {
      console.warn('[keepAlive] ping failed:', err.message);
    }
  };
  setTimeout(() => { ping(); setInterval(ping, PING_INTERVAL_MS); }, 60_000);
  console.log(`[keepAlive] self-ping every ${PING_INTERVAL_MS / 60000} min -> ${target}`);
}

const start = startKeepAlive;

module.exports = { start, startKeepAlive };
