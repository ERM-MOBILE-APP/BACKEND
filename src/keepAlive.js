const PING_PATH       = '/api/_health';
const PING_INTERVAL_MS = 14 * 60 * 1000;

function start() {
  const url = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || '').trim();
  if (!url) {
    console.log('[keepAlive] No RENDER_EXTERNAL_URL set — self-ping disabled.');
    return;
  }
  const target = url.replace(/\/$/, '') + PING_PATH;
  const ping = async () => {
    try {
      const res = await fetch(target);
      console.log(`[keepAlive] ping ${target} → ${res.status} @ ${new Date().toISOString()}`);
    } catch (err) {
      console.warn('[keepAlive] ping failed:', err.message);
    }
  };
  setTimeout(() => { ping(); setInterval(ping, PING_INTERVAL_MS); }, 60_000);
  console.log(`[keepAlive] ✓ self-ping every ${PING_INTERVAL_MS / 60000} min → ${target}`);
}

module.exports = { start };
