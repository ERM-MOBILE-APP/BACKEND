/**
 * One-off migration helpers for unifying the mobile ERM database with the
 * HRMS database. Once the consolidation is verified, these endpoints can
 * be removed.
 *
 * Both require the `x-admin-secret` header (same as every admin endpoint).
 */

const mongoose = require('mongoose');
const User     = require('../models/User');   // now points at `employees`

/**
 * Build a placeholder employee document from a legacy mobile user. Used
 * when the legacy user has no matching `employees` row yet — we create
 * one filled with HRMS-required placeholders so admin can edit later.
 *
 * Keeps the original password hash so login keeps working.
 */
function buildStubEmployee(u) {
  const parts = String(u.name || 'Unknown User').trim().split(/\s+/);
  const firstName = parts[0] || 'Unknown';
  const lastName  = parts.slice(1).join(' ') || 'User';
  const usernameBase = String(u.email || '').toLowerCase().split('@')[0]
    .replace(/[^a-z0-9_.-]/g, '') || 'user' + Math.random().toString(36).slice(2, 6);
  let phone = String(u.phone || '').replace(/[\s-]/g, '');
  if (!/^\d{10,15}$/.test(phone)) phone = '0000000000';
  let joiningDate = new Date(u.createdAt || Date.now());
  if (isNaN(joiningDate.getTime())) joiningDate = new Date();

  return {
    firstName,
    lastName,
    username:   usernameBase,
    // Keep the original hashed password verbatim — bcrypt hashes are self-
    // contained so they work regardless of which app saved them.
    password:   u.password,
    email:      String(u.email).toLowerCase(),
    phone,
    employeeId: u.userId,
    employmentType: 'Full-time',
    joiningDate,
    salary:      0,
    assignedTo: 'HR (auto-imported)',
    education: {
      degree:         'Other Professional Certificate',
      university:     'Not specified',
      fieldOfStudy:   'Not specified',
      graduationYear: 2020,
    },
    status:   u.status === 'Inactive' ? 'Inactive' : 'Active',
    isActive: u.status !== 'Inactive',
    role:     u.role     || 'employee',
    dob:        u.dob        || '',
    gender:     u.gender     || '',
    bloodGroup: u.bloodGroup || '',
    photoUrl:   u.photoUrl   || '',
    workType:   u.workType   || 'Remote',
    leaveBalance:      u.leaveBalance      ?? 12,
    permissionBalance: u.permissionBalance ?? 4,
    address: {
      street: typeof u.address === 'string' ? u.address : '',
      city: '', state: '', zipCode: '', country: '',
    },
  };
}

function checkAdmin(req, res) {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) {
    res.status(503).json({ message: 'ADMIN_SECRET not configured on server.' });
    return false;
  }
  if (!got || got !== expected) {
    res.status(401).json({ message: 'Missing or invalid x-admin-secret header.' });
    return false;
  }
  return true;
}

/**
 * POST /api/auth/admin/migrate-users-to-employees
 *
 * Walks every doc in the legacy `users` collection and, for each one whose
 * email matches a doc in `employees`, copies the password hash + missing
 * mobile-only fields (role/dob/gender/bloodGroup/photoUrl/workType/
 * leaveBalance/permissionBalance) onto the matching employee. This is what
 * lets a user who originally signed up via the mobile/admin.html with
 * (say) `akash1701` keep using that exact password to log into the mobile
 * app even after we move to the unified `employees` collection.
 *
 * Idempotent — safe to re-run; only copies fields when the employee
 * doesn't already have them.
 *
 * Body: { dryRun: boolean }   — if true, just reports what would change
 */
exports.migrateUsersToEmployees = async (req, res) => {
  if (!checkAdmin(req, res)) return;

  const dryRun = req.body?.dryRun === true;
  try {
    // Read legacy users collection directly (bypass the User model, since
    // that model now writes to `employees`).
    const db        = mongoose.connection.db;
    const legacyCol = db.collection('users');
    const legacyUsers = await legacyCol.find({}).toArray();

    if (legacyUsers.length === 0) {
      return res.json({
        success:  true,
        dryRun,
        message:  'Legacy `users` collection is empty — nothing to migrate.',
        migrated: 0, skipped: 0, missing: 0,
      });
    }

    // Body flag — set createStubs:false on the request body if you'd
    // rather NOT auto-create employee stubs for missing legacy users.
    const createStubs = req.body?.createStubs !== false;   // default true

    let migrated      = 0;
    let stubsCreated  = 0;
    let skipped       = 0;
    const missing     = [];     // would-be stubs (dryRun) or actually-created (live)
    const changes     = [];

    for (const u of legacyUsers) {
      if (!u.email) { skipped++; continue; }
      const employee = await User.findOne({ email: String(u.email).toLowerCase() });

      // ─── No matching employee → optionally create a stub ────────────
      if (!employee) {
        if (!createStubs) {
          missing.push({ email: u.email, userId: u.userId, name: u.name });
          continue;
        }
        missing.push({ email: u.email, userId: u.userId, name: u.name, action: 'create-stub' });
        if (!dryRun) {
          try {
            // Insert directly through Mongoose collection to keep the
            // original bcrypt hash (pre-save would re-hash it).
            await mongoose.connection.db.collection('employees').insertOne({
              ...buildStubEmployee(u),
              createdAt: new Date(u.createdAt || Date.now()),
              updatedAt: new Date(),
            });
            stubsCreated++;
          } catch (err) {
            console.error(`[migrate-users] stub create failed for ${u.email}:`, err.message);
          }
        } else {
          stubsCreated++;   // count what we WOULD create
        }
        continue;
      }

      // Build a set of fields to copy — only ones the employee doesn't have.
      const setOps = {};
      if (u.password && !employee.password)            setOps.password          = u.password;
      // Always overwrite the password from legacy if it exists, since the
      // import-from-mobile step set the placeholder 'ImportedFromMobile!2026'.
      // If you want to preserve the placeholder instead, remove this line.
      if (u.password)                                  setOps.password          = u.password;
      if (u.role        && !employee.role)             setOps.role              = u.role;
      if (u.dob         && !employee.dob)              setOps.dob               = u.dob;
      if (u.gender      && !employee.gender)           setOps.gender            = u.gender;
      if (u.bloodGroup  && !employee.bloodGroup)       setOps.bloodGroup        = u.bloodGroup;
      if (u.photoUrl    && !employee.photoUrl)         setOps.photoUrl          = u.photoUrl;
      if (u.workType    && !employee.workType)         setOps.workType          = u.workType;
      if (u.leaveBalance != null && !employee.leaveBalance)
        setOps.leaveBalance = u.leaveBalance;
      if (u.permissionBalance != null && !employee.permissionBalance)
        setOps.permissionBalance = u.permissionBalance;

      if (Object.keys(setOps).length === 0) {
        skipped++;
        continue;
      }

      changes.push({ email: u.email, fields: Object.keys(setOps) });

      if (!dryRun) {
        // updateOne bypasses the pre-save hook so the already-hashed legacy
        // password copies across verbatim — exactly what we want.
        await mongoose.connection.db.collection('employees').updateOne(
          { _id: employee._id },
          { $set: setOps },
        );
      }
      migrated++;
    }

    return res.json({
      success:  true,
      dryRun,
      total:    legacyUsers.length,
      migrated,
      stubsCreated,
      skipped,
      missingInEmployees: missing,
      changes,
      message: dryRun
        ? `DRY RUN — would migrate ${migrated} and create ${stubsCreated} stub(s) of ${legacyUsers.length} legacy users.`
        : `Migrated ${migrated} and created ${stubsCreated} stub(s) of ${legacyUsers.length} legacy users.`,
    });
  } catch (err) {
    console.error('[migrate-users-to-employees]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/auth/admin/wipe-employees
 *
 * Danger-zone endpoint that empties the `employees` collection. Requires
 * BOTH the x-admin-secret header AND a body containing
 *   { "confirm": "DELETE_ALL_EMPLOYEES" }
 * so it can't be triggered by accident.
 *
 * Use case: you want to start admin creation from zero in HRMS. After
 * wiping, every employee row is gone — mobile logins will all fail with
 * "Invalid credentials" until you recreate via the HRMS New Employee form.
 *
 * NOT TOUCHED (still hold data that references the deleted employees by
 * _id — orphaned but harmless until you also clear them):
 *   • attendances, leaves, allowances, notifications, payslips,
 *     complaints, attendancerequests
 * Pass { "alsoWipeRelated": true } to also blow those collections away.
 *
 * Returns: { success, deletedEmployees, deletedRelated, message }
 */
exports.wipeEmployees = async (req, res) => {
  if (!checkAdmin(req, res)) return;

  const body            = req.body || {};
  const confirm         = String(body.confirm || '');
  const alsoWipeRelated = body.alsoWipeRelated === true;

  if (confirm !== 'DELETE_ALL_EMPLOYEES') {
    return res.status(400).json({
      success: false,
      message:
        'Confirmation required. POST body must include ' +
        '{"confirm":"DELETE_ALL_EMPLOYEES"} to proceed.',
    });
  }

  try {
    const db = mongoose.connection.db;
    const result = await db.collection('employees').deleteMany({});
    const deletedEmployees = result.deletedCount || 0;

    // Optional: wipe related collections that reference employees by _id.
    const deletedRelated = {};
    if (alsoWipeRelated) {
      const cols = ['attendances', 'leaves', 'allowances', 'notifications',
                    'payslips', 'complaints', 'attendancerequests'];
      for (const name of cols) {
        try {
          const r = await db.collection(name).deleteMany({});
          deletedRelated[name] = r.deletedCount || 0;
        } catch (err) {
          // Collection might not exist — that's fine.
          deletedRelated[name] = `error: ${err.message}`;
        }
      }
    }

    console.warn(`[wipeEmployees] cleared ${deletedEmployees} employee(s)` +
      (alsoWipeRelated ? ` + related: ${JSON.stringify(deletedRelated)}` : ''));

    return res.json({
      success: true,
      deletedEmployees,
      deletedRelated: alsoWipeRelated ? deletedRelated : 'not-requested',
      message: `Wiped ${deletedEmployees} employee(s).` +
               (alsoWipeRelated ? ' Related collections also cleared.' : ''),
    });
  } catch (err) {
    console.error('[wipeEmployees]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/auth/admin/drop-users-collection
 *
 * Drops the legacy `users` collection. RUN ONLY AFTER you've verified
 * migrate-users-to-employees worked AND mobile login works against the
 * unified `employees` collection. There's no undo (Mongo drops are
 * permanent — your only recovery is the Atlas backup snapshot).
 */
exports.dropUsersCollection = async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const db          = mongoose.connection.db;
    const collections = await db.listCollections({ name: 'users' }).toArray();
    if (collections.length === 0) {
      return res.json({ success: true, message: 'Legacy `users` collection does not exist.' });
    }
    await db.collection('users').drop();
    return res.json({ success: true, message: 'Legacy `users` collection dropped. Done.' });
  } catch (err) {
    console.error('[drop-users-collection]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
