import { query } from '../db/connection.js';
import { formatPhone } from '../utils/business-hours.js';
import { classifyDisposition, processDisposition, extractRmFromCallDetails } from '../routes/exotel.js';

/**
 * Stuck-call resolver. Runs every minute via pg-boss.
 *
 * ARCHITECTURE:
 * This is the ONLY path that classifies dispositions in the normal flow.
 * The status-callback handler just records the fact that Exotel fired, and
 * the resolver (running on a cron) does the actual classification against
 * Exotel's settled Call Details response.
 *
 * WHY THE 3-MINUTE DELAY:
 * Exotel's Call Details API is eventually-consistent. The Leg2Status and
 * ConversationDuration fields take 1-3 minutes to populate post-call. If
 * we classify earlier, we get false RM_CONNECTED for customer-hangup calls
 * (Call.To contains the Exophone instead of an RM).
 *
 * SAFETY VALVE:
 * After 10 minutes stuck with no settled Exotel data, we abandon to
 * CALL_FAILED so leads never hang forever.
 */
export async function resolveStuckCalls() {
  const stuckRes = await query(
    `SELECT id, lead_id, call_sid, created_at
       FROM call_logs
      WHERE disposition = 'INITIATED'
        AND call_sid IS NOT NULL
        AND created_at < NOW() - INTERVAL '180 seconds'
      ORDER BY created_at ASC
      LIMIT 20`
  );

  if (stuckRes.rows.length === 0) return { processed: 0 };

  let processed = 0;

  for (const row of stuckRes.rows) {
    try {
      const ageMs = Date.now() - new Date(row.created_at).getTime();

      // Safety valve — if stuck > 10min, mark CALL_FAILED and move lead on.
      // Downstream retry logic will still kick in for the lead via the normal
      // processDisposition pipeline.
      if (ageMs > 10 * 60 * 1000) {
        console.warn(`[RESOLVER] ${row.lead_id} stuck > 10min, classifying as CALL_FAILED`);
        await processDisposition(
          row.lead_id, row.call_sid, 'CALL_FAILED',
          '', 0, '', 'timeout',
          { source: 'resolver-timeout' }
        );
        processed++;
        continue;
      }

      const details = await fetchExotelCallDetailsLocal(row.call_sid);
      if (!details) continue;

      const status = (details.Status || details.status || '').toLowerCase();
      if (status === 'in-progress' || status === 'ringing' || status === 'queued' || !status) {
        continue; // still in flight, check again next tick
      }

      const duration = parseInt(details.Duration || details.duration || 0);
      const recordingUrl = details.RecordingUrl || details.recording_url || '';

      const { dialWhom, dialStatus, conversationDuration } = extractRmFromCallDetails(details);
      const normalizedDialWhom = dialWhom ? formatPhone(dialWhom) : '';

      const disposition = classifyDisposition({
        status, dialStatus, dialWhom: normalizedDialWhom, duration, rawMessage: '',
      });

      console.log(`[RESOLVER] ${row.lead_id} (${row.call_sid}): status=${status} dialStatus=${dialStatus || '-'} dialWhom=${normalizedDialWhom || '-'} dur=${duration}/${conversationDuration}s → ${disposition}`);

      await processDisposition(
        row.lead_id, row.call_sid, disposition,
        normalizedDialWhom, duration, recordingUrl, status,
        { source: 'resolver' }
      );
      processed++;

    } catch (err) {
      console.error(`[RESOLVER] Error on ${row.lead_id}:`, err.message);
    }
  }

  return { processed };
}

// Local copy to avoid a circular dep via routes/exotel.js (we don't re-export
// fetchExotelCallDetails from there). Keeps this file self-contained for the
// Exotel API call specifically.
async function fetchExotelCallDetailsLocal(callSid) {
  const sid = process.env.EXOTEL_ACCOUNT_SID;
  const key = process.env.EXOTEL_API_KEY;
  const token = process.env.EXOTEL_API_TOKEN;
  const base = process.env.EXOTEL_API_BASE || 'https://api.exotel.com/v1';
  const url = `${base}/Accounts/${sid}/Calls/${callSid}.json?details=true`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${key}:${token}`).toString('base64') },
    });
    if (res.ok) {
      const data = await res.json();
      return data?.Call || data?.call || data;
    }
    console.warn(`[RESOLVER] Exotel fetch HTTP ${res.status} for ${callSid}`);
    return null;
  } catch (err) {
    console.error('[RESOLVER] Exotel fetch error:', err.message);
    return null;
  }
}
