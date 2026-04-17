import PgBoss from 'pg-boss';
import { processPendingRetries, processQueuedLeads } from '../services/retry-manager.js';

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

  // Retry worker — every 60 seconds
  await boss.schedule('process-retries', '* * * * *'); // every minute
  await boss.work('process-retries', async () => {
    try {
      const result = await processPendingRetries();
      if (result.processed > 0) console.log(`Retries processed: ${result.processed}`);
    } catch (err) {
      console.error('Retry worker error:', err.message);
    }
  });

  // Queue processor — every 60 seconds
  await boss.schedule('process-queue', '* * * * *');
  await boss.work('process-queue', async () => {
    try {
      const result = await processQueuedLeads();
      if (result.processed > 0) console.log(`Queued leads processed: ${result.processed}`);
    } catch (err) {
      console.error('Queue worker error:', err.message);
    }
  });

  console.log('Workers registered: process-retries, process-queue');
  return boss;
}

export async function stopWorkers() {
  if (boss) await boss.stop({ graceful: true, timeout: 10000 });
}
