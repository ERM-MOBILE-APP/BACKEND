/**
 * Allowlist of employee names whose petrol claim distance MUST be
 * computed from GPS polyline (between their check-in and check-out
 * time), not the value they typed into the form.
 *
 * HR's rule (May 2026): for the field-sales + execution teams listed
 * below, the petrol amount is reimbursed by actual distance driven on
 * the day, measured by the mobile app's LocationPing trail between
 * the day's check-in and check-out. The employee can still file a
 * petrol claim — the typed distance is just a hint; the doc's stored
 * `distance` is overwritten with the polyline value at submit time.
 *
 * Matching is case-insensitive on first-name only so a small typo
 * ("PRAVEEN" vs "Praveen Raja") still hits. Add a name here to opt
 * the employee in; remove to opt out.
 */
const PETROL_GPS_NAMES = [
  'aniish kumar',
  'dhakshna moorthy',
  'suresh',
  'praveen raja',
  'azar abdhul ali',
  'sathish',
  'ranganathan',
  'tamilarasan',
  'velmani',
  'sasikumar',
  'madhan',
  'mugesh',
];

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

// Does this user object belong to the GPS-petrol allowlist?
//
// Resolution order (most specific wins):
//   1. The per-employee `petrolEligible` flag — set explicitly by HR
//      from the New Employee form (Jun 2026). `true` opts the
//      employee in even if their dept/name wouldn't otherwise match,
//      `false` opts them out even if their dept/name would.
//   2. Full name match in PETROL_GPS_NAMES.
//   3. First-name match (so "Praveen" matches "Praveen Raja").
//   4. Department is exactly 'sales' or 'execution'.
exports.isPetrolGpsEmployee = function (user) {
  if (!user) return false;
  // Per-employee flag wins — it's an explicit HR decision, not a heuristic.
  if (typeof user.petrolEligible === 'boolean') return user.petrolEligible;
  const dept = normalize(user.department && user.department.name) ||
               normalize(user.departmentName) ||
               normalize(user.department);
  if (dept === 'sales' || dept === 'execution') return true;
  const full = normalize(
    user.name ||
    [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  );
  if (!full) return false;
  if (PETROL_GPS_NAMES.includes(full)) return true;
  const first = full.split(/\s+/)[0];
  return PETROL_GPS_NAMES.some(n => n === first || n.split(/\s+/)[0] === first);
};

exports.PETROL_GPS_NAMES = PETROL_GPS_NAMES;

/**
 * Petrol reimbursement rate. HR set this to ₹3.50 per kilometre in
 * May 2026. When the allowlist branch computes a polyline distance,
 * the Allowance amount is overwritten to (distance × this rate) so
 * the employee can't accidentally over- or under-claim.
 *
 * Override by setting PETROL_RATE_RUPEES_PER_KM on the backend env.
 */
exports.PETROL_RATE_RUPEES_PER_KM = Number(
  process.env.PETROL_RATE_RUPEES_PER_KM || 3.5
);
