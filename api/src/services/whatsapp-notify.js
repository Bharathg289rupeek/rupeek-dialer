/**
 * WhatsApp notification service.
 *
 * Fires a single POST to WHATSAPP_NOTIFY_URL. The caller decides WHEN to fire;
 * this module only formats and transmits the payload.
 *
 * Extras added vs. the previous version:
 *   - `assigned_to`  — populated only on RM_CONNECTED with the RM's email.
 *   - `tag`          — 'already_called' (RM connected) or 'not_called'
 *                      (customer never reached).
 *   - Every non-RM-connect payload now has `lead_source = 'rupeek_dailer'`
 *     overriding the original source, per product requirement.
 *     RM_CONNECTED keeps the original lead_source.
 */
export async function triggerWhatsAppNotification(lead, disposition, callData = {}) {
  const endpoint = process.env.WHATSAPP_NOTIFY_URL;
  if (!endpoint) {
    console.log('[WHATSAPP] WHATSAPP_NOTIFY_URL not set, skipping notification');
    return null;
  }

  // Decide which lead_source to report downstream.
  //   RM_CONNECTED                  → original lead_source (e.g. chakra)
  //   everything else                → 'rupeek_dailer'  (so downstream can
  //                                    differentiate system-generated follow-ups
  //                                    from the original lead)
  const sourceForPayload = disposition === 'RM_CONNECTED'
    ? (lead.lead_source || 'chakra')
    : 'rupeek_dailer';

  const payload = {
    phone:           lead.customer_phone?.replace('+91', '') || '',
    name:            lead.customer_name || 'Customer',
    loan_amount:     lead.loan_amount ? parseFloat(lead.loan_amount) : 0,
    branch_id:       lead.branch_id || '',
    loan_type:       lead.loan_type || '',
    lead_source:     sourceForPayload,
    city:            lead.city || '',
    pincode:         lead.pincode || '',
    lead_id:         lead.lead_id,
    disposition:     callData.disposition_override || disposition,
    tag:             callData.tag || null,
    assigned_to:     callData.assigned_to || null, // RM email on RM_CONNECTED, else null
    call_sid:        callData.call_sid || '',
    rm_who_answered: callData.rm_who_answered || '',
    call_duration:   callData.call_duration_sec || 0,
    attempt_number:  callData.attempt_number || 1,
    timestamp:       new Date().toISOString(),
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    console.log(`[WHATSAPP] ${lead.lead_id} ${disposition} tag=${payload.tag || '-'} assigned_to=${payload.assigned_to || '-'} → HTTP ${res.status}`);
    return { status: res.status, response: body };
  } catch (err) {
    console.error(`[WHATSAPP] ${lead.lead_id} failed:`, err.message);
    return null;
  }
}
