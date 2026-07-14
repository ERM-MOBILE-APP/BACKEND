/**
 * #379 — One-shot startup migration: delete duplicate LocationPing rows so
 * the new unique compound index on (user, date, bucket) can be built.
 *
 * Before this deploy, the raced dedup let 2-3 rows land in the same
 * 2-minute bucket for the same employee (observed for TES080: 3 rows
 * within 69 ms). MongoDB will refuse to create the unique index while
 * those duplicates exist, so we sweep them first — keeping the FIRST
 * row per bucket and deleting the rest.
 *
 * Runs at boot, is idempotent, and no-ops if nothing to sweep.
 * Cost: one aggregate + one deleteMany per employee/day with dupes.
 */
const LocationPing = require('../models/LocationPing');

async function dedupLocationPings() {
  try {
    // Group by (user, date, bucket) and keep the earliest row per group.
    // If bucket field doesn't exist yet on old rows, derive it on the fly.
    console.log('[dedup-migration] starting sweep…');

    const t0 = Date.now();
    const pipeline = [
      {
        $addFields: {
          _bucket: {
            $ifNull: [
              '$bucket',
              { $floor: { $divide: [{ $toLong: '$recordedAt' }, 120000] } },
            ],
          },
        },
      },
      {
        $group: {
          _id:     { user: '$user', date: '$date', bucket: '$_bucket' },
          ids:     { $push: '$_id' },
          count:   { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ];

    const dupes = await LocationPing.aggregate(pipeline).allowDiskUse(true);
    if (dupes.length === 0) {
      console.log('[dedup-migration] no duplicates — clean');
    } else {
      let toDelete = [];
      for (const g of dupes) {
        // Keep the FIRST id (earliest inserted), delete the rest.
        const [keep, ...rest] = g.ids;
        toDelete.push(...rest);
      }
      const chunkSize = 1000;
      let deleted = 0;
      for (let i = 0; i < toDelete.length; i += chunkSize) {
        const chunk = toDelete.slice(i, i + chunkSize);
        const r = await LocationPing.deleteMany({ _id: { $in: chunk } });
        deleted += r.deletedCount || 0;
      }
      console.log(`[dedup-migration] deleted ${deleted} duplicate rows`);
    }

    // Backfill bucket on any row that doesn't have it yet.
    //
    // #396 — Use the raw MongoDB driver via `.collection.updateMany()`
    // instead of Mongoose's Model.updateMany. In Mongoose 7+, passing an
    // aggregation-pipeline array as the update argument throws
    //   "Cannot pass an array to query updates unless the `updatePipeline`
    //    option is set."
    // The raw driver accepts pipeline updates natively without any flag,
    // and since this is a one-shot boot-time migration we don't need
    // Mongoose middleware anyway. This also survives Mongoose upgrades.
    const backfill = await LocationPing.collection.updateMany(
      { bucket: { $exists: false } },
      [
        {
          $set: {
            bucket: {
              $floor: { $divide: [{ $toLong: '$recordedAt' }, 120000] },
            },
          },
        },
      ]
    );
    if (backfill.modifiedCount) {
      console.log(`[dedup-migration] backfilled bucket on ${backfill.modifiedCount} rows`);
    }

    // #403 — Purge any remaining null-bucket orphans. These are rows
    // that predate `bucket: required: true` in the schema. They cause
    // E11000 500 responses on every new /location-ping because two
    // null-bucket rows for the same user+date collide on the unique
    // (user, date, bucket) index. Deleting them completely removes the
    // possibility of collision.
    const nullPurge = await LocationPing.collection.deleteMany(
      { $or: [
          { bucket: null },
          { bucket: { $exists: false } },
          { bucket: { $type: 'string' } },
        ]
      }
    );
    if (nullPurge.deletedCount) {
      console.log(`[dedup-migration] purged ${nullPurge.deletedCount} null-bucket orphan rows`);
    }

    // Ensure the PARTIAL unique index exists. Old non-partial or
    // non-unique variants get dropped first so createIndex succeeds
    // cleanly with the new options.
    const idxes = await LocationPing.collection.indexes();
    for (const idx of idxes) {
      const sameKey = JSON.stringify(idx.key) === JSON.stringify({ user: 1, date: 1, bucket: 1 });
      if (!sameKey) continue;
      const alreadyCorrect =
        idx.unique === true &&
        idx.partialFilterExpression &&
        JSON.stringify(idx.partialFilterExpression) === JSON.stringify({ bucket: { $type: 'number' } });
      if (alreadyCorrect) continue;
      try {
        await LocationPing.collection.dropIndex(idx.name);
        console.log('[dedup-migration] dropped stale index', idx.name);
      } catch (e) {
        console.warn('[dedup-migration] could not drop', idx.name, ':', e.message);
      }
    }
    try {
      await LocationPing.collection.createIndex(
        { user: 1, date: 1, bucket: 1 },
        {
          unique: true,
          name: 'user_date_bucket_unique',
          partialFilterExpression: { bucket: { $type: 'number' } },
        }
      );
      console.log('[dedup-migration] partial unique index in place');
    } catch (e) {
      if (e.code === 85 /* IndexOptionsConflict */) {
        console.log('[dedup-migration] unique index already exists — ok');
      } else {
        throw e;
      }
    }

    console.log(`[dedup-migration] done in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('[dedup-migration] failed:', err.message);
  }
}

module.exports = { dedupLocationPings };
