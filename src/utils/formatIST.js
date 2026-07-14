/**
 * #404 — Format a JS Date (or ISO string, or ms epoch) as
 * "YYYY-MM-DD HH:mm:ss" in Asia/Kolkata (IST, UTC+05:30).
 *
 * Purpose: cosmetic sidecar for DB rows so HR opening Robo 3T can read
 * the local wall-clock time at a glance without doing UTC→IST math.
 * The authoritative timestamp remains the UTC Date field alongside it
 * (e.g. `recordedAt`, `checkIn`). Every existing query, aggregation,
 * cron, and date-range comparison continues to run against the UTC
 * Date; the local string is display-only.
 *
 * Returns '' for null/invalid input so callers can safely do
 *   record.checkOutLocal = fmtIST(record.checkOut)
 * without a manual null check.
 */
function fmtIST(input) {
  if (input == null) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  try {
    // Intl.DateTimeFormat with an IANA timezone → correct offset
    // year-round (India doesn't observe DST but this is future-proof).
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year:   'numeric',
      month:  '2-digit',
      day:    '2-digit',
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const g = (t) => (parts.find(p => p.type === t)?.value || '').padStart(2, '0');
    let hh = g('hour');
    // en-GB with hour12:false can emit "24" at midnight — normalise to "00".
    if (hh === '24') hh = '00';
    return `${g('year')}-${g('month')}-${g('day')} ${hh}:${g('minute')}:${g('second')}`;
  } catch {
    // Fallback: manual +5:30 offset if Intl is somehow unavailable.
    const ms = d.getTime() + (5.5 * 60 * 60 * 1000);
    const s  = new Date(ms).toISOString();
    return s.replace('T', ' ').slice(0, 19);
  }
}

module.exports = { fmtIST };
