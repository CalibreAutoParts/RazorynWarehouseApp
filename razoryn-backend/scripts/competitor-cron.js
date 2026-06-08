// scripts/competitor-cron.js — one-shot competitor scan runner.
//
// Use this if you prefer Railway's native cron service (a separate service that
// runs `npm run competitors:run` on a schedule) rather than the in-process
// node-cron in server.js.
//
// To wire it up on Railway:
//   1. Create a second service in the same project, pointing to the same repo.
//   2. Set its start command to: npm run competitors:run
//   3. Add a cron schedule in service Settings → Schedule (e.g. 0 */6 * * *)
//   4. Reuse the same env vars (Railway lets you reference them across services).
require('dotenv').config();

(async () => {
  try {
    const monitor = require('../services/competitor-monitor');
    const result = await monitor.scanAll();
    console.log('[competitor-cron] done', JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    console.error('[competitor-cron] failed:', e);
    process.exit(1);
  }
})();
