import PgBoss from 'pg-boss';
import { processPendingRetries, processQueuedLeads } from '../services/retry-manager.js';
import { resolveStuckCalls } from '../services/call-resolver.js';

let boss = null;

export async function startWorkers() {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    retryLimit: 2,
    retryDelay: 30,
    monitorStateIntervalSeconds: 30,
  });

  boss.on('error', err => console.error('pg-boss error:', err));

  await boss.start();
  console.log('pg-boss started');

  // 1. Retry worker — picks up due rows from retry_queue, triggers retries
  await boss.schedule('process-retries', '* * * * *');
  await boss.work('process-retries', async () => {
    try {
      const result = await processPendingRetries();
      if (result.processed > 0) console.log(`[WORKER] retries processed: ${result.processed}`);
    } catch (err) {
      console.error('[WORKER] retry error:', err.message);
    }
  });

  // 2. Queue processor — picks up queued (after-hours) leads when business hours open
  await boss.schedule('process-queue', '* * * * *');
  await boss.work('process-queue', async () => {
    try {
      const result = await processQueuedLeads();
      if (result.processed > 0) console.log(`[WORKER] queued leads processed: ${result.processed}`);
    } catch (err) {
      console.error('[WORKER] queue error:', err.message);
    }
  });

  // 3. Stuck-call resolver — durable backup for StatusCallback misses.
  //    In-process setTimeout polls don't survive server restarts; this does.
  await boss.schedule('resolve-stuck-calls', '* * * * *');
  await boss.work('resolve-stuck-calls', async () => {
    try {
      const result = await resolveStuckCalls();
      if (result.processed > 0) console.log(`[WORKER] stuck calls resolved: ${result.processed}`);
    } catch (err) {
      console.error('[WORKER] resolver error:', err.message);
    }
  });

  console.log('Workers registered: process-retries, process-queue, resolve-stuck-calls');
  return boss;
}

export async function stopWorkers() {
  if (boss) await boss.stop({ graceful: true, timeout: 10000 });
}
