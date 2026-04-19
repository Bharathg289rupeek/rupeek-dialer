import { query } from '../db/connection.js';

/**
 * Trigger WhatsApp notification for disposition via OneStop API.
 * Called after every call attempt to notify about lead status.
 */
export async function triggerWhatsAppNotification(lead, disposition, callData = {}) {
  const endpoint = process.env.WHATSAPP_NOTIFY_URL;
  if (!endpoint) {
    console.log('WHATSAPP_NOTIFY_URL not set, skipping WhatsApp notification');
    return null;
  }

  const payload = {
    phone: lead.customer_phone?.replace('+91', '') || '',
    name: lead.customer_name || 'Customer',
    loan_amount: lead.loan_amount ? parseFloat(lead.loan_amount) : 0,
    branch_id: lead.branch_id || '',
    loan_type: lead.loan_type || '',
    lead_source: lead.lead_source || 'chakra',
    city: lead.city || '',
    pincode: lead.pincode || '',
    lead_id: lead.lead_id,
    disposition: disposition,
    call_sid: callData.call_sid || '',
    rm_who_answered: callData.rm_who_answered || '',
    call_duration: callData.call_duration_sec || 0,
    attempt_number: callData.attempt_number || 1,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.text();
    console.log(`WhatsApp notify for ${lead.lead_id}: ${res.status} - ${disposition}`);
    return { status: res.status, response: data };
  } catch (err) {
    console.error(`WhatsApp notify failed for ${lead.lead_id}:`, err.message);
    return null;
  }
}
