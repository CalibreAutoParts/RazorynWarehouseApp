// scripts/sync-cron.js — one-shot sync runner
//
// Use this if you prefer Railway's native cron service (separate service that
// runs npm run sync:run on a schedule) rather than the in-process node-cron.
//
// To wire it up on Railway:
//   1. Create a second service in the same project, pointing to the same repo.
//   2. Set its start command to: npm run sync:run
//   3. Add a cron schedule in service Settings → Schedule (e.g. */5 * * * *)
//   4. Reuse the same env vars (Railway lets you reference them across services).
require('dotenv').config();

(async () => {
  try {
    const sync = require('../services/sync');
    const result = await sync.runFullSync();
    console.log('[sync-cron] done', JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    console.error('[sync-cron] failed:', e);
    process.exit(1);
  }
})();
