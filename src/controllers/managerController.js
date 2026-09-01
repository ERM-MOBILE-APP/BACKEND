/**
 * Manager Controller (MOBILE backend) — team-scoped reads + approvals for
 * the ERM Mobile "Manager" experience.
 *
 * Ported from the ERM Web backend's managerController so the two surfaces
 * behave identically. Both backends share the same MongoDB, so anything a
 * manager does here (approve/reject a leave, allowance, attendance request,
 * post a team announcement) is immediately visible on ERM Web + HRMS and
 * vice-versa — no extra sync layer needed.
 *
 * Manager identity model (same as web):
 *   The HRMS Employee form has an `assignedTo` field — a free-text manager
 *   display name (e.g. "Vivek", "Vishnu K"). Every endpoint here:
 *     1. Resolves the logged-in user (via JWT — handled by authMiddleware).
 *     2. Builds the list of subordinate user _ids whose `assignedTo`
 *        matches the manager's display name (case-insensitive,
 *        whitespace-tolerant, also cross-checked against the shared
 *        `managers` directory collection).
 *     3. Filters the requested resource to those subordinates only, and
 *        re-checks team membership before any write (403 otherwise).
 *
 * No subordinates → returns empty arrays, never errors.
 *
 * SECURITY: these routes are JWT-authenticated (authMiddleware). There is
 * no separate "manager role" required at the route layer — a signed-in
 * user only ever sees / acts on their OWN team because every query and
 * every write is scoped by resolveTeamIds(). A non-manager (no
 * subordinates) simply gets empty results and cannot act on anyone.
 */

const mongoose      = require('mongoose');
const User          = require('../models/User');
const Leave         = require('../models/Leave');
const Allowance     = require('../models/Allowance');
const Attendance    = require('../models/Attendance');
const LocationPing  = require('../models/LocationPing');
const Announcement  = require('../models/Announcement');

/**
 * Resolve the logged-in manager's display name. Tries firstName + lastName
 * first (HRMS canonical), falls back to `name` (mobile legacy), and as a
 * last resort the bare firstName / employeeId. Used to match `assignedTo`
 * strings on subordinate records.
 */
function managerDisplayNames(user) {
  if (!user) return [];
  const names = new Set();
  const first = (user.firstName || '').trim();
  const last  = (user.lastName  || '').trim();
  const full  = [first, last].filter(Boolean).join(' ').trim();
  if (full)            names.add(full);
  if (first)           names.add(first);
  if (user.name)       names.add(String(user.name).trim());
  // #490 — DO NOT match assignedTo against the manager's employeeId / userId.
  // `assignedTo` always holds a manager NAME (that's what the HRMS dropdown
  // stores). Matching it against an ID could wrongly claim an employee whose
  // assignedTo coincidentally equals a manager's id, and keeps stale team
  // membership after a reassignment. Name-only matching is the source of truth.
  return [...names].filter(Boolean);
}

/**
 * Build a Mongo filter that matches `assignedTo` against ANY of the
 * manager's possible display names — case-insensitive, whitespace-tolerant,
 * and tolerant of a trailing " - title" / " — title" suffix (the dropdown
 * sometimes stores the rendered label).
 */
function assignedToFilter(names) {
  if (!names || names.length === 0) return { _id: null };  // matches nothing
  const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const orClauses = names.flatMap((n) => {
    const safe = escape(n.trim());
    return [
      { assignedTo: new RegExp(`^\\s*${safe}\\s*$`, 'i') },
      { assignedTo: new RegExp(`^\\s*${safe}\\s*[-–—]`, 'i') },
    ];
  });
  return { $or: orClauses };
}

// Fields every subordinate row needs across the manager endpoints.
const TEAM_SELECT = '_id firstName lastName name email phone employeeId designation department designationTitle departmentName photoUrl presence lastLocation lastSeenAt status isActive';

/**
 * Whether a team member is currently EMPLOYED (not terminated/resigned/
 * inactive). Terminated staff still resolve into the team (so Team Members can
 * badge them "Inactive"), but they're excluded from Attendance Reports and Live
 * Tracking — they have no ongoing attendance or location to show.
 */
function isActiveMember(u) {
  const s = String((u && u.status) || 'Active').trim();
  return (u && u.isActive !== false) && !['Terminated', 'Inactive', 'Resigned'].includes(s);
}

// ── Short-TTL request-spanning caches (#513 perf) ──────────────────────────
// The Manager hub fires several endpoints back-to-back (team, hierarchy, four
// pending queues), and EACH used to re-walk the whole `assignedTo` tree from
// scratch (many DB round-trips + a managers-directory lookup per level). That
// repeated BFS is why the section sometimes took seconds to load. These caches
// memoise a person's downline / direct reports for a few seconds, so the burst
// of calls shares one computed result. Staleness is bounded and harmless — a
// reporting change simply takes up to TTL to appear.
const DOWNLINE_TTL_MS = 30000;
const _downlineCache = new Map(); // idStr → { at, team, names }
const _directCache   = new Map(); // idStr → { at, reports }

/**
 * Resolve the FULL downline for the logged-in manager — #510 senior-manager
 * hierarchy. Not just direct reports: we walk the reporting tree DOWNWARD.
 *
 *   Senior Manager → Manager → Employees
 *
 * `assignedTo` on each employee holds their DIRECT manager's NAME, so the tree
 * is implicit. We BFS it: match the manager's names → direct reports; for each
 * report who is themselves a manager (their name appears as someone's
 * assignedTo) queue their name → next level; repeat. So a Senior Manager sees
 * the Manager AND the Manager's team, automatically, with no manual add.
 *
 * Guards: a visited-name set (never query the same name twice) + a visited-id
 * set (never collect the same person twice, and never include self) break any
 * accidental reporting cycle; a depth cap is a final safety net.
 *
 * Because it's derived live from `assignedTo`, reassigning an employee in HRMS
 * instantly changes who each manager (and every manager above) can see.
 */
/**
 * Seed match-names for a person: their own display names + any aliases the
 * shared `managers` directory records under the same email/name. The directory
 * name is the value HR stores in reports' `assignedTo`, and it can differ from
 * the User-row name (initials, spacing) — folding it in keeps the reporting
 * chain from breaking below the first level.
 */
async function seedNamesFor(person) {
  const seedNames = managerDisplayNames(person);
  try {
    const mgrCol = mongoose.connection.db.collection('managers');
    const orClauses = [];
    if (person.email) orClauses.push({ email: String(person.email).toLowerCase() });
    for (const n of seedNames) {
      orClauses.push({ name: new RegExp(`^\\s*${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') });
    }
    if (orClauses.length > 0) {
      const hits = await mgrCol.find({ isActive: true, $or: orClauses }).toArray();
      for (const h of hits) if (h && h.name) seedNames.push(String(h.name).trim());
    }
  } catch (e) {
    console.warn('[manager.seedNamesFor] directory lookup failed:', e.message);
  }
  return [...new Set(seedNames.filter((s) => s && String(s).trim()))];
}

/**
 * Resolve the DIRECT reports of a person (level 1 only) — everyone whose
 * `assignedTo` names this person. Used to build the hierarchy tree one tier at
 * a time (a Senior Manager's direct reports, a Manager's own team, …).
 */
async function directReportsOf(person) {
  if (!person) return [];
  const key = String(person._id);
  const hit = _directCache.get(key);
  if (hit && (Date.now() - hit.at) < DOWNLINE_TTL_MS) return hit.reports;

  const seedNames = await seedNamesFor(person);
  const meIdStr = key;
  const found = await User.find(assignedToFilter(seedNames)).select(TEAM_SELECT).lean();
  const reports = found.filter((u) => String(u._id) !== meIdStr);
  _directCache.set(key, { at: Date.now(), reports });
  return reports;
}

/**
 * Resolve the FULL downline for ANY person by BFS-ing the `assignedTo` tree
 * DOWNWARD (Senior Manager → Manager → Employees). Parametrised on a user doc
 * so the same walk serves both the logged-in caller and a sub-manager the
 * caller is drilling into. See resolveTeamIds/resolveScopedTeam for callers.
 */
async function resolveDownline(me) {
  if (!me) return { team: [], names: [] };

  const cacheKey = String(me._id);
  const cached = _downlineCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < DOWNLINE_TTL_MS) {
    return { team: cached.team, names: cached.names };
  }

  const seedNames = await seedNamesFor(me);
  const teamById  = new Map();   // _id string → user (unique downline members)
  const seenNames = new Set();   // lowercased names already queried
  const meIdStr   = String(me._id);
  const namesAll  = [...seedNames];
  let   frontier  = [...seedNames];
  let   depth     = 0;

  while (frontier.length && depth < 12) {
    depth++;
    const toQuery = frontier.filter((n) => {
      const k = String(n).toLowerCase();
      if (seenNames.has(k)) return false;
      seenNames.add(k);
      return true;
    });
    if (!toQuery.length) break;

    const level = await User.find(assignedToFilter(toQuery)).select(TEAM_SELECT).lean();
    const newMembers = [];
    for (const u of level) {
      const idStr = String(u._id);
      if (idStr === meIdStr) continue;      // never include self
      if (teamById.has(idStr)) continue;    // already collected
      teamById.set(idStr, u);
      newMembers.push(u);
    }

    const next = [];
    const pushName = (nm) => {
      if (nm && !seenNames.has(String(nm).toLowerCase())) { next.push(nm); namesAll.push(nm); }
    };
    // A member might be a sub-manager → reach THEIR reports next. Match on names
    // from BOTH the User row AND the shared `managers` directory (the directory
    // name is what HR stores in the reports' `assignedTo`).
    for (const u of newMembers) managerDisplayNames(u).forEach(pushName);
    try {
      const mgrCol = mongoose.connection.db.collection('managers');
      const or = [];
      for (const u of newMembers) {
        if (u.email) or.push({ email: String(u.email).toLowerCase() });
        for (const nm of managerDisplayNames(u)) {
          or.push({ name: new RegExp(`^\\s*${String(nm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') });
        }
      }
      if (or.length) {
        const hits = await mgrCol.find({ isActive: true, $or: or }).toArray();
        for (const h of hits) if (h && h.name) pushName(String(h.name).trim());
      }
    } catch { /* non-fatal — User-row names still drive the match */ }

    frontier = [...new Set(next)];
  }

  const team  = [...teamById.values()];
  const names = [...new Set(namesAll.filter((s) => s && String(s).trim()))];
  _downlineCache.set(cacheKey, { at: Date.now(), team, names });
  return { team, names };
}

async function resolveTeamIds(req) {
  const me = await User.findById(req.user.id).lean();
  if (!me) return { manager: null, team: [], names: [] };
  const { team, names } = await resolveDownline(me);
  return { manager: me, team, names };
}

/**
 * Resolve the team to READ for a request, honouring an optional
 * `?managerId=` (a.k.a. `?viewAs=`) that lets a higher-level manager drill
 * into a sub-manager's dashboard. Scoping rules (enforced here, server-side):
 *
 *   • No managerId               → the caller's own full downline.
 *   • managerId = self           → the caller's own full downline.
 *   • managerId ∈ caller downline → THAT sub-manager's downline.
 *   • managerId anywhere else    → denied:true (403) — a manager can NEVER
 *                                   view a team outside their own hierarchy.
 *
 * So a Senior Manager opening "Monica" gets exactly Monica's team; nobody can
 * forge a managerId to peek at an unrelated team.
 */
async function resolveScopedTeam(req) {
  const me = await User.findById(req.user.id).lean();
  if (!me) return { manager: null, target: null, team: [], names: [], denied: false };

  const managerId = String(req.query.managerId || req.query.viewAs || '').trim();
  // `scope=direct` → only the target's DIRECT reports (level 1), not the full
  // recursive downline. Used for a senior manager's OWN section (their direct
  // team, excluding sub-managers' sub-teams) and the "direct reports only"
  // announcement audience.
  const directOnly = String(req.query.scope || '').trim().toLowerCase() === 'direct';

  if (!managerId || managerId === String(me._id)) {
    if (directOnly) {
      const team = await directReportsOf(me);
      return { manager: me, target: me, team, names: [], denied: false };
    }
    const { team, names } = await resolveDownline(me);
    return { manager: me, target: me, team, names, denied: false };
  }

  // Authorise: the target must be somewhere in the caller's own downline.
  const { team: myTeam } = await resolveDownline(me);
  const inMyTeam = myTeam.some((u) => String(u._id) === managerId);
  if (!inMyTeam) {
    return { manager: me, target: null, team: [], names: [], denied: true };
  }

  const targetDoc = await User.findById(managerId).lean();
  if (!targetDoc) return { manager: me, target: null, team: [], names: [], denied: true };

  if (directOnly) {
    const team = await directReportsOf(targetDoc);
    return { manager: me, target: targetDoc, team, names: [], denied: false };
  }
  const { team, names } = await resolveDownline(targetDoc);
  return { manager: me, target: targetDoc, team, names, denied: false };
}

/**
 * Shared guard for read endpoints: resolve the scoped team or send a 403 for a
 * forged / out-of-hierarchy managerId. Returns the scope object, or null (after
 * responding) when access was denied.
 */
async function scopeOrDeny(req, res) {
  const scoped = await resolveScopedTeam(req);
  if (scoped.denied) {
    res.status(403).json({ success: false, message: 'This manager is not in your reporting hierarchy.' });
    return null;
  }
  return scoped;
}

// ─── helpers ────────────────────────────────────────────────────────
function pickLabel(value, sidecar) {
  const isHex = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
  if (value && typeof value === 'object') {
    const t = value.title || value.name || '';
    if (t && !isHex(t)) return t;
  }
  if (typeof value === 'string' && value && !isHex(value)) return value;
  if (sidecar && typeof sidecar === 'string' && !isHex(sidecar)) return sidecar;
  return '';
}

/**
 * GET /api/manager/me
 * Single source of truth for "am I a manager?". isManager is true if ANY of:
 *   1. role === 'manager' on the user row.
 *   2. email/name present in the active `managers` directory.
 *   3. the user has ≥1 subordinate (assignedTo match).
 */
exports.me = async (req, res) => {
  try {
    const me = await User.findById(req.user.id).lean();
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    const signals = { byRole: false, byDirectory: false, byTeam: false };
    let directoryName = '';

    signals.byRole = String(me.role || '').toLowerCase() === 'manager';

    try {
      const mgrCol = mongoose.connection.db.collection('managers');
      if (me.email) {
        const hit = await mgrCol.findOne({ email: String(me.email).toLowerCase(), isActive: true });
        if (hit) { signals.byDirectory = true; directoryName = hit.name || ''; }
      }
      if (!signals.byDirectory) {
        const fullName = [me.firstName || '', me.lastName || ''].filter(Boolean).join(' ').trim();
        if (fullName) {
          const hit = await mgrCol.findOne({
            name: new RegExp(`^\\s*${fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'),
            isActive: true,
          });
          if (hit) { signals.byDirectory = true; directoryName = hit.name || ''; }
        }
      }
    } catch (e) {
      console.warn('[manager.me] directory check failed:', e.message);
    }

    let teamSize = 0;
    try {
      const { team } = await resolveTeamIds(req);
      teamSize = team.length;
      signals.byTeam = teamSize > 0;
    } catch (e) {
      console.warn('[manager.me] team resolution failed:', e.message);
    }

    const isManager = signals.byRole || signals.byDirectory || signals.byTeam;
    const tag = me.email || me.employeeId || String(me._id);
    console.log(`[manager.me] ${tag} isManager=${isManager} byRole=${signals.byRole} byDirectory=${signals.byDirectory} byTeam=${signals.byTeam} teamSize=${teamSize}`);
    res.json({ success: true, isManager, signals, teamSize, directoryName });
  } catch (err) {
    console.error('[manager.me]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/hierarchy?managerId=<id>
 * One TIER of the reporting tree, so the Manager section can render it as an
 * expandable hierarchy instead of a flat blob:
 *
 *   Senior Manager
 *   ├── Manager A            (expandable → open A's dashboard, scoped to A)
 *   │     └── … A's team
 *   ├── Manager B            (expandable → open B's dashboard, scoped to B)
 *   └── Employee C           (a plain direct report — no sub-team)
 *
 * Returns the DIRECT reports of the node being viewed, split into:
 *   • managers      → direct reports who themselves have a downline (each
 *                     carries teamCount = size of their full downline).
 *   • directReports → direct reports with no team of their own (leaf members).
 *
 * `managerId` drills one level down (open Manager A → get A's direct reports),
 * authorised exactly like every other scoped endpoint: the target must live in
 * the caller's own hierarchy or the request is refused. Everything is derived
 * live from `assignedTo`, so an HRMS reassignment restructures the tree with no
 * code change.
 */
exports.hierarchy = async (req, res) => {
  try {
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return; // 403 already sent
    const node = scoped.target;                 // whose tier we're listing
    if (!node) return res.status(404).json({ success: false, message: 'Manager not found.' });

    const directs  = await directReportsOf(node);

    // #515 perf — resolve every direct report CONCURRENTLY. Each needs a
    // "is this person a manager?" check (a cheap cached direct-reports lookup)
    // and, only for actual managers, a full-downline count. Running them in
    // parallel (instead of awaiting one-by-one) collapses ~N sequential DB
    // round-trips into a few concurrent batches — the main reason the section
    // was slow to load.
    const resolved = await Promise.all(directs.map(async (r) => {
      const base = {
        _id:         r._id,
        employeeId:  r.employeeId,
        name:        r.name || [r.firstName, r.lastName].filter(Boolean).join(' ').trim(),
        email:       r.email || '',
        phone:       r.phone || '',
        photoUrl:    r.photoUrl || '',
        designation: pickLabel(r.designation, r.designationTitle),
        department:  pickLabel(r.department,  r.departmentName),
        status:      r.status || 'Active',
        active:      (r.isActive !== false) &&
                     !['Terminated', 'Inactive', 'Resigned'].includes(String(r.status || 'Active')),
      };
      const subDirects = await directReportsOf(r);
      if (subDirects.length === 0) return { isManager: false, node: base };
      const sub = await resolveDownline(r);
      return { isManager: true, node: { ...base, teamCount: sub.team.length } };
    }));

    const managers = resolved.filter((x) => x.isManager).map((x) => x.node);
    const leaves   = resolved.filter((x) => !x.isManager).map((x) => x.node);

    res.json({
      success: true,
      manager: node ? {
        _id:        node._id,
        name:       [node.firstName, node.lastName].filter(Boolean).join(' ').trim() || node.name,
        employeeId: node.employeeId,
        email:      node.email,
      } : null,
      managers,
      directReports: leaves,
      counts: { managers: managers.length, directReports: leaves.length },
    });
  } catch (err) {
    console.error('[manager.hierarchy]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/team
 * Returns the list of subordinates assigned to the logged-in manager.
 */
exports.team = async (req, res) => {
  try {
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return;
    const { target: manager, team, names } = scoped;
    const tag = manager
      ? (manager.email || manager.employeeId || String(manager._id))
      : 'unknown';
    console.log(
      `[manager.team] ${tag} role=${manager?.role || 'n/a'} ` +
      `names=[${names.join(' | ')}] team=${team.length}`
    );
    res.json({
      success: true,
      manager: manager ? {
        _id:        manager._id,
        name:       [manager.firstName, manager.lastName].filter(Boolean).join(' ').trim() || manager.name,
        employeeId: manager.employeeId,
        email:      manager.email,
      } : null,
      managerDisplayNames: names,
      count: team.length,
      team:  team.map((u) => ({
        _id:        u._id,
        employeeId: u.employeeId,
        name:       u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
        email:      u.email,
        phone:      u.phone || '',
        photoUrl:   u.photoUrl || '',
        designation: pickLabel(u.designation, u.designationTitle),
        department:  pickLabel(u.department,  u.departmentName),
        presence:    u.presence    || 'offline',
        lastLocation:u.lastLocation || null,
        lastSeenAt:  u.lastSeenAt   || null,
        // #486 — employment status, so Manager Access can show a terminated /
        // resigned member as "Inactive" and stop treating them as active.
        status:      u.status || 'Active',
        active:      (u.isActive !== false) &&
                     !['Terminated', 'Inactive', 'Resigned'].includes(String(u.status || 'Active')),
      })),
    });
  } catch (err) {
    console.error('[manager.team]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/leaves?status=pending|approved|rejected&month=&year=
 * Leave + permission requests filed by the logged-in manager's team.
 */
exports.leaves = async (req, res) => {
  try {
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return;
    const { team } = scoped;
    const ids = team.map((u) => u._id);
    if (ids.length === 0) return res.json({ success: true, items: [] });

    const q = { user: { $in: ids } };
    if (req.query.status) q.status = String(req.query.status).toLowerCase();

    const items = await Leave
      .find(q)
      .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, items });
  } catch (err) {
    console.error('[manager.leaves]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/allowances?type=travel|petrol&status=
 * Allowance claims filed by the logged-in manager's team. Petrol and
 * Travel are the SAME collection discriminated by `type` — always pass
 * ?type= to keep them separate in the UI.
 */
exports.allowances = async (req, res) => {
  try {
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return;
    const { team } = scoped;
    const ids = team.map((u) => u._id);
    if (ids.length === 0) return res.json({ success: true, items: [] });

    const q = { user: { $in: ids } };
    if (req.query.type)   q.type   = String(req.query.type).toLowerCase();
    if (req.query.status) q.status = String(req.query.status).toLowerCase();

    const items = await Allowance
      .find(q)
      .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, items });
  } catch (err) {
    console.error('[manager.allowances]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/manager/leaves/:id   { managerStatus: 'Approved' | 'Rejected' }
 * Manager acts on a subordinate's leave/permission request. Stored as
 * managerStatus so HRMS knows whether to enable HR's Approve/Reject.
 * On Reject we also close status='rejected' (final) so the employee sees
 * an immediate change; on Approve status stays 'pending' for HR.
 */
exports.actLeave = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    const ids = new Set(team.map((u) => String(u._id)));
    const doc = await Leave.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (!ids.has(String(doc.user))) {
      return res.status(403).json({ success: false, message: 'This request does not belong to your team.' });
    }
    const status = String(req.body.managerStatus || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'managerStatus must be Approved or Rejected' });
    }
    const me = await User.findById(req.user.id).lean();
    const myName =
      (me && (me.name || [me.firstName, me.lastName].filter(Boolean).join(' ').trim())) ||
      'Manager';
    doc.managerStatus   = status === 'approved' ? 'Approved' : 'Rejected';
    doc.managerStatusBy = myName;
    doc.managerStatusAt = new Date();
    if (status === 'rejected') {
      doc.status     = 'rejected';
      doc.reviewedAt = new Date();
      doc.reviewedBy = doc.reviewedBy || `Manager (${myName})`;
      doc.hrComment  = doc.hrComment  || `Manager rejection (${myName}).`;
    }
    await doc.save();

    // Notify the employee for BOTH approval and rejection.
    try {
      const { notify } = require('../utils/notify');
      const kind = doc.requestType === 'permission' ? 'Permission' : 'Leave';
      const when = kind === 'Permission'
        ? `${doc.date}${doc.startTime && doc.endTime ? ` (${doc.startTime} - ${doc.endTime})` : ''}`
        : `${doc.startDate}${doc.endDate && doc.endDate !== doc.startDate ? ` - ${doc.endDate}` : ''}`;
      const isApproved = doc.managerStatus === 'Approved';
      const title = isApproved
        ? `${kind} approved by your manager`
        : `${kind} rejected by your manager`;
      const body  = isApproved
        ? `Your ${kind.toLowerCase()} request for ${when} is approved. Awaiting HR review.`
        : `Your ${kind.toLowerCase()} request for ${when} was rejected by ${myName}.`;
      const userIdForNotif = doc.user?._id || doc.user;
      await notify(userIdForNotif, {
        title,
        body,
        type: 'leave',
        link: '/(tabs)/leave',
      });
    } catch (e) {
      console.warn('[manager.actLeave] notify failed:', e.message);
    }

    // NOTE: The ERM Web backend dual-writes this decision to the mobile
    // backend (this service) via /api/leave/admin/:id. Here we ARE the
    // mobile backend, writing the canonical Leave doc + Notification
    // directly, so no dual-write is needed (and would be a pointless
    // self-call). HRMS / ERM Web read the same DB, so they update live.

    res.json({ success: true, item: doc });
  } catch (err) {
    console.error('[manager.actLeave]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/manager/allowances/:id
 * Body: { managerStatus: 'Approved'|'Rejected',
 *         approvedAmount?, rejectedAmount?, amountComment? }
 * Supports partial approval (approve part of the claimed amount).
 */
exports.actAllowance = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    const ids = new Set(team.map((u) => String(u._id)));
    const doc = await Allowance.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (!ids.has(String(doc.user))) {
      return res.status(403).json({ success: false, message: 'This request does not belong to your team.' });
    }
    const status = String(req.body.managerStatus || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'managerStatus must be Approved or Rejected' });
    }

    const claimed = Number(doc.amount) || 0;
    let approvedAmount = req.body.approvedAmount;
    let rejectedAmount = req.body.rejectedAmount;
    if (approvedAmount !== undefined) approvedAmount = Number(approvedAmount);
    if (rejectedAmount !== undefined) rejectedAmount = Number(rejectedAmount);
    if (status === 'approved') {
      if (!isFinite(approvedAmount)) approvedAmount = claimed;
      if (approvedAmount < 0 || approvedAmount > claimed) {
        return res.status(400).json({ success: false, message: `approvedAmount must be between 0 and ${claimed}` });
      }
      rejectedAmount = Math.max(0, claimed - approvedAmount);
    } else {
      approvedAmount = 0;
      rejectedAmount = claimed;
    }

    const me2 = await User.findById(req.user.id).lean();
    const myName2 =
      (me2 && (me2.name || [me2.firstName, me2.lastName].filter(Boolean).join(' ').trim())) ||
      'Manager';
    doc.managerStatus   = status === 'approved' ? 'Approved' : 'Rejected';
    doc.managerStatusBy = myName2;
    doc.managerStatusAt = new Date();
    doc.approvedAmount  = approvedAmount;
    doc.rejectedAmount  = rejectedAmount;
    if (typeof req.body.amountComment === 'string') {
      doc.amountComment = req.body.amountComment;
    }
    await doc.save();

    try {
      const { notify } = require('../utils/notify');
      const claimedAmt = Number(doc.amount) || 0;
      const approvedRs = Math.max(0, Number(approvedAmount) || 0);
      const rejectedRs = Math.max(0, Number(rejectedAmount) || 0);
      const fmt = (n) => '₹' + Number(n).toLocaleString('en-IN');
      let bodyLine;
      if (status === 'approved' && rejectedRs > 0) {
        bodyLine = `Approved ${fmt(approvedRs)} of your ${fmt(claimedAmt)} claim ` +
                   `(${fmt(rejectedRs)} not approved). Awaiting HR review.`;
      } else if (status === 'approved') {
        bodyLine = `Approved ${fmt(approvedRs)} for your claim. Awaiting HR review.`;
      } else {
        bodyLine = `Your ${fmt(claimedAmt)} claim was rejected by your manager.`;
      }
      const reason = String(req.body.amountComment || '').trim();
      if (reason) bodyLine += ` Reason: ${reason}`;
      await notify(doc.user, {
        title: `Allowance ${doc.managerStatus.toLowerCase()} by your manager`,
        body:  bodyLine,
        type:  'allowance',
        link:  '/(tabs)/allowance',
      });
    } catch (e) {
      console.warn('[manager.actAllowance] notify failed:', e.message);
    }

    res.json({ success: true, item: doc });
  } catch (err) {
    console.error('[manager.actAllowance]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/attendance?date=YYYY-MM-DD
 * Team attendance roll for a single date.
 */
exports.attendance = async (req, res) => {
  try {
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return;
    const { team } = scoped;
    const ids = team.map((u) => u._id);
    if (ids.length === 0) return res.json({ success: true, items: [] });

    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    const items = await Attendance
      .find({ user: { $in: ids }, date })
      .populate('user', 'firstName lastName name employeeId email designation designationTitle')
      .lean();
    res.json({ success: true, date, items });
  } catch (err) {
    console.error('[manager.attendance]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/attendance-summary?month=&year=
 * Per-team-member monthly summary (present/late/absent/permission/halfday
 * + total worked hours). Drives the manager Reports screen.
 */
exports.attendanceSummary = async (req, res) => {
  try {
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return;
    // #514 — terminated / resigned staff have no ongoing attendance, so they're
    // excluded from the Attendance Report (they still show as Inactive in the
    // Team Members list).
    const team = scoped.team.filter(isActiveMember);
    if (team.length === 0) return res.json({ success: true, items: [] });

    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    const year  = parseInt(req.query.year,  10) || new Date().getFullYear();
    const monthStr = String(month).padStart(2, '0');
    const start = `${year}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end   = `${year}-${monthStr}-${String(lastDay).padStart(2, '0')}`;

    // #470 — Use the CANONICAL monthly summary the ERM app + HRMS use
    // (computeMonthlySummary), so the manager's team report shows the EXACT
    // same present / late / absent / permission counts HR sees. That routine
    // applies the fully-approved leave/permission overlay, the holiday-as-
    // present rule, and the approved-permission count fix (#451). Reading the
    // raw Attendance.status here (the old approach) diverged from HRMS on
    // permission days, HR-overridden days, Sundays, and reclassified late
    // arrivals. Lazy-require avoids any module-load cycle with the controller.
    const { computeMonthlySummary } = require('./attendanceController');

    // One bulk query for worked-hours totals (computeMonthlySummary doesn't
    // return hours). Summed per member from the same month's rows.
    const hourRows = await Attendance.find({
      user: { $in: team.map((u) => u._id) },
      date: { $gte: start, $lte: end },
    }).select('user workedHours').lean();
    const hoursByUser = new Map();
    for (const r of hourRows) {
      const k = String(r.user);
      hoursByUser.set(k, (hoursByUser.get(k) || 0) + Number(r.workedHours || 0));
    }

    const items = await Promise.all(team.map(async (u) => {
      let s = { present: 0, late: 0, absent: 0, permission: 0, halfday: 0, leave: 0 };
      try {
        s = await computeMonthlySummary(u._id, month, year);
      } catch (e) {
        console.warn('[manager.attendanceSummary] computeMonthlySummary failed for', String(u._id), e.message);
      }
      return {
        userId:      String(u._id),
        employeeId:  u.employeeId,
        name:        u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
        designation: pickLabel(u.designation, u.designationTitle),
        present:     s.present    || 0,
        late:        s.late       || 0,
        absent:      s.absent     || 0,
        permission:  s.permission || 0,
        halfday:     s.halfday    || 0,
        leave:       s.leave      || 0,
        totalWorkedHours: hoursByUser.get(String(u._id)) || 0,
      };
    }));

    res.json({ success: true, month, year, items });
  } catch (err) {
    console.error('[manager.attendanceSummary]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/live-locations
 * Latest GPS sample for each team member, today only. Drives the Live
 * Tracking screen on the manager dashboard.
 */
exports.liveLocations = async (req, res) => {
  try {
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return;
    // #514 — don't track terminated / resigned staff (no active device / shift).
    const team = scoped.team.filter(isActiveMember);
    if (team.length === 0) return res.json({ success: true, data: [] });

    const today = new Date().toISOString().slice(0, 10);
    const attendanceMap = new Map();
    const atts = await Attendance.find({
      user: { $in: team.map((u) => u._id) },
      date: today,
    }).select('user checkIn checkOut workedHours checkInLat checkInLng').lean();
    for (const a of atts) attendanceMap.set(String(a.user), a);

    const out = await Promise.all(team.map(async (u) => {
      const ping = await LocationPing.findOne({ user: u._id, date: today })
        .sort({ recordedAt: -1 })
        .lean()
        .catch(() => null);

      let lat = null, lng = null, recordedAt = null, speed = null;
      if (ping) {
        lat = ping.lat; lng = ping.lng; recordedAt = ping.recordedAt; speed = ping.speed;
      } else if (u.lastLocation && u.lastLocation.lat != null) {
        lat = u.lastLocation.lat; lng = u.lastLocation.lng; recordedAt = u.lastSeenAt;
      }

      const att = attendanceMap.get(String(u._id));
      const isCheckedIn = !!(att && att.checkIn && !att.checkOut);

      let status = 'offline';
      if (lat != null && recordedAt) {
        const ageMin = (Date.now() - new Date(recordedAt).getTime()) / 60000;
        if (ageMin <= 25 && isCheckedIn) status = 'active';
        else if (u.presence === 'idle')  status = 'idle';
      } else if (isCheckedIn) {
        status = 'active';
      }

      return {
        _id:        String(u._id),
        employeeId: u.employeeId,
        name:       u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
        designation: pickLabel(u.designation, u.designationTitle),
        photoUrl:   u.photoUrl || '',
        lat, lng, speed,
        status,
        checkIn:    att?.checkIn  || null,
        checkOut:   att?.checkOut || null,
        // Where the employee CHECKED IN today (for the "checked in at"
        // place label on the manager Live Tracking screen). Distinct from
        // lat/lng, which is their latest/current position.
        checkInLat: att?.checkInLat ?? null,
        checkInLng: att?.checkInLng ?? null,
        lastSeen:   recordedAt,
      };
    }));

    res.json({ success: true, data: out, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[manager.liveLocations]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/attendance-requests?status=pending|approved|rejected
 * Regularisation requests filed by the manager's team.
 */
exports.attendanceRequests = async (req, res) => {
  try {
    const AttendanceRequest = require('../models/AttendanceRequest');
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return;
    const { team } = scoped;
    const teamIds  = team.map((u) => u._id);
    if (teamIds.length === 0) return res.json({ success: true, items: [] });
    const filter = { user: { $in: teamIds } };
    const status = String(req.query.status || '').toLowerCase();
    if (['pending', 'approved', 'rejected', 'expired'].includes(status)) {
      filter.status = status;
    }
    const items = await AttendanceRequest.find(filter)
      .populate('user', 'firstName lastName name employeeId email designation designationTitle department departmentName')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, items });
  } catch (err) {
    console.error('[manager.attendanceRequests]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/manager/attendance-requests/:id  { status, managerComment? }
 * Manager approves or rejects a subordinate's attendance regularisation.
 * Approve → managerStatus='Approved', status stays 'pending' for HR.
 * Reject  → managerStatus='Rejected', status='rejected' (final).
 */
exports.actAttendanceRequest = async (req, res) => {
  try {
    const AttendanceRequest = require('../models/AttendanceRequest');
    const { team } = await resolveTeamIds(req);
    const ids = new Set(team.map((u) => String(u._id)));
    const doc = await AttendanceRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (!ids.has(String(doc.user))) {
      return res.status(403).json({ success: false, message: 'Request does not belong to your team.' });
    }
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be approved or rejected' });
    }
    const me = await User.findById(req.user.id).lean();
    const myName =
      (me && (me.name || [me.firstName, me.lastName].filter(Boolean).join(' ').trim())) ||
      'Manager';

    doc.managerStatus   = status === 'approved' ? 'Approved' : 'Rejected';
    doc.managerStatusBy = myName;
    doc.managerStatusAt = new Date();
    if (typeof req.body.managerComment === 'string' && req.body.managerComment) {
      doc.managerComment = req.body.managerComment;
    } else if (typeof req.body.hrComment === 'string' && req.body.hrComment) {
      doc.managerComment = req.body.hrComment;
    }
    if (status === 'rejected') {
      doc.status     = 'rejected';
      doc.reviewedBy = `Manager (${myName})`;
      doc.reviewedAt = new Date();
    } else {
      doc.status = 'pending';
    }
    await doc.save();

    try {
      const { notify } = require('../utils/notify');
      const userIdForNotif = doc.user?._id || doc.user;
      const noteSuffix = doc.managerComment ? ` Note: "${doc.managerComment}"` : '';
      const bodyLine = status === 'approved'
        ? `Your regularisation for ${doc.date} was approved by ${myName}. Awaiting HR review.${noteSuffix}`
        : `Your regularisation for ${doc.date} was rejected by ${myName}.${noteSuffix}`;
      await notify(userIdForNotif, {
        title: `Attendance request ${status} by your manager`,
        body:  bodyLine,
        type:  'attendance',
        link:  '/(tabs)/attendance',
      });
    } catch (e) {
      console.warn('[manager.actAttendanceRequest] notify failed:', e.message);
    }
    res.json({ success: true, item: doc });
  } catch (err) {
    console.error('[manager.actAttendanceRequest]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─── Manager announcements ────────────────────────────────────────── */

/**
 * POST /api/manager/announcements   { title, body, category? }
 * Posts an announcement that ONLY the manager's direct team will see. The
 * audience is snapshotted at post-time (audienceUserIds) so later
 * re-assignments don't change who sees this specific post.
 *
 * NOTE: mobile Announcement.audience enum is ['all','department','team'],
 * so we store 'team' (the web backend uses 'manager-team'; functionally
 * identical here — scoped by postedByUser + audienceUserIds). The employee
 * announcement feed (announcementController.list) filters 'team' posts to
 * their audienceUserIds so they never leak to the whole company.
 */
exports.postAnnouncement = async (req, res) => {
  try {
    const scoped = await scopeOrDeny(req, res);
    if (!scoped) return;
    // Post AS the caller, TO the scoped team (own team, or a sub-manager's team
    // when a higher-level manager posts from inside that manager's section).
    const manager = scoped.manager;
    const team    = scoped.team;
    if (!manager) return res.status(401).json({ success: false, message: 'Manager not found.' });
    if (team.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'You don\'t have any subordinates. Only managers can post team announcements.',
      });
    }
    const title = String(req.body?.title || '').trim();
    const body  = String(req.body?.body  || '').trim();
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Title and body are required.' });
    }
    const category = ['holiday', 'policy', 'event', 'general'].includes(req.body?.category)
      ? req.body.category
      : 'general';

    const postedByName =
      manager.name ||
      [manager.firstName, manager.lastName].filter(Boolean).join(' ').trim() ||
      'Manager';

    const doc = await Announcement.create({
      title,
      body,
      category,
      audience:        'team',
      postedBy:        postedByName,
      postedByUser:    manager._id,
      audienceUserIds: team.map((u) => u._id),
      isActive:        true,
    });

    try {
      const { notify } = require('../utils/notify');
      await Promise.all(team.map((u) =>
        notify(u._id, {
          title: `New announcement from ${postedByName}`,
          body:  title,
          type:  'announcement',
        })
      ));
    } catch (e) {
      console.warn('[manager.postAnnouncement] notify failed:', e.message);
    }

    res.status(201).json({ success: true, announcement: doc, teamSize: team.length });
  } catch (err) {
    console.error('[manager.postAnnouncement]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/announcements
 * Announcements this manager has posted to their team.
 */
exports.myAnnouncements = async (req, res) => {
  try {
    const me = await User.findById(req.user.id).lean();
    if (!me) return res.json({ success: true, items: [] });
    const items = await Announcement.find({
      postedByUser: me._id,
      // Match BOTH team-scoped audience values so a manager sees their own
      // team announcements whether posted from ERM mobile ('team') or ERM
      // web ('manager-team').
      audience:     { $in: ['team', 'manager-team'] },
      isActive:     true,
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, items });
  } catch (err) {
    console.error('[manager.myAnnouncements]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/manager/announcements/:id
 * Soft-delete one of the manager's own team announcements.
 */
exports.deleteAnnouncement = async (req, res) => {
  try {
    const me = await User.findById(req.user.id).lean();
    if (!me) return res.status(401).json({ success: false, message: 'Unauthorised.' });
    const doc = await Announcement.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    if (String(doc.postedByUser) !== String(me._id)) {
      return res.status(403).json({ success: false, message: 'You can only delete your own announcements.' });
    }
    doc.isActive = false;
    await doc.save();
    res.json({ success: true });
  } catch (err) {
    console.error('[manager.deleteAnnouncement]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports.resolveTeamIds = resolveTeamIds;
