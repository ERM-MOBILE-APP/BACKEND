/**
 * notifyManager — fire a notification to an employee's MANAGER when the
 * employee submits something that needs manager action (leave, permission,
 * allowance, attendance regularisation).
 *
 * This is the inverse of managerController.resolveTeamIds: an employee's
 * `assignedTo` string holds their manager's display name, so we resolve the
 * manager User from it (via the shared `managers` directory first, then a
 * name match) and drop a Notification on their bell. Fully best-effort — it
 * never throws into the request path (a missing/ambiguous manager just means
 * no notification, never a failed submit).
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const { notify } = require('./notify');

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve the manager User _id for an employee (or null). */
async function resolveManagerId(employee) {
  const raw = String(employee?.assignedTo || '').trim();
  if (!raw) return null;
  // "Vivek - Technical Lead" / "Vivek — Lead" → "Vivek"
  const base = raw.split(/\s*[-–—]\s*/)[0].trim();
  if (!base) return null;
  const rx = new RegExp('^\\s*' + esc(base) + '\\s*$', 'i');

  // 1) Shared managers directory → email → User (most reliable).
  try {
    const mgrCol = mongoose.connection.db.collection('managers');
    const hit = await mgrCol.findOne({ isActive: true, name: rx });
    if (hit && hit.email) {
      const u = await User.findOne({ email: String(hit.email).toLowerCase() }).select('_id').lean();
      if (u) return u._id;
    }
  } catch { /* directory optional */ }

  // 2) Direct match on a stored `name` field (mobile legacy rows).
  try {
    const u = await User.findOne({ name: rx }).select('_id').lean();
    if (u) return u._id;
  } catch { /* ignore */ }

  // 3) Match firstName then confirm the full name equals the assignedTo base.
  try {
    const first = base.split(/\s+/)[0];
    const cands = await User.find({ firstName: new RegExp('^' + esc(first) + '$', 'i') })
      .select('_id firstName lastName name')
      .lean();
    for (const c of cands) {
      const full = (c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).trim();
      if (full && full.toLowerCase() === base.toLowerCase()) return c._id;
    }
    if (cands.length === 1) return cands[0]._id;
  } catch { /* ignore */ }

  return null;
}

/**
 * Notify the manager of `employeeUserId` about a new request.
 * @param employeeUserId  the submitting employee's _id
 * @param opts.type       notification type ('leave'|'allowance'|'attendance')
 * @param opts.summary    short human summary, e.g. "Casual Leave 12–15 Mar"
 * @param opts.link       deep link (defaults to the manager approvals screen)
 */
async function notifyManagerOfRequest(employeeUserId, opts = {}) {
  try {
    const emp = await User.findById(employeeUserId)
      .select('assignedTo firstName lastName name employeeId')
      .lean();
    if (!emp) return null;

    const managerId = await resolveManagerId(emp);
    if (!managerId) return null;
    if (String(managerId) === String(employeeUserId)) return null; // don't self-notify

    const empName =
      emp.name || [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim() || 'An employee';
    const empTag = emp.employeeId ? ` (${emp.employeeId})` : '';
    // #512 — the notification title must distinguish a Permission from a Leave.
    // Both are stored in the Leave collection and notified with type:'leave',
    // so callers pass an explicit `kindLabel` (e.g. 'permission request') to
    // override the type-derived default; otherwise it fell back to
    // 'leave request' and a permission wrongly read as a leave request.
    const kindLabel =
      opts.kindLabel ? opts.kindLabel
        : opts.type === 'allowance' ? 'allowance claim'
          : opts.type === 'attendance' ? 'attendance request'
            : 'leave request';

    return await notify(managerId, {
      title: `New ${kindLabel} from ${empName}`,
      body: `${empName}${empTag} submitted: ${opts.summary || kindLabel}. Tap to review.`,
      type: opts.type || 'general',
      link: opts.link || '/manager/approvals',
    });
  } catch (e) {
    console.warn('[notifyManager] failed:', e.message);
    return null;
  }
}

module.exports = { notifyManagerOfRequest, resolveManagerId };
