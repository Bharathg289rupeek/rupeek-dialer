export const LEAD_STATUSES = ['new', 'in_progress', 'connected', 'queued', 'failed', 'utm_created'];

export const DISPOSITIONS = {
  RM_CONNECTED: 'Customer successfully connected to RM',
  RM_CONNECTED_CX_NO_ANSWER: 'RM picked but customer did not answer',
  RM_NO_ANSWER: 'No RM answered within ring window',
  RM_NO_ANSWER_CALLCENTER: 'No RM answered, routed to call centre',
  CUSTOMER_NOT_PICKED: 'Customer did not answer outbound call',
  CX_DROP_VOICEBOT: 'Customer disconnected during voicebot greeting',
  CALL_FAILED: 'Technical failure — invalid number or network error',
  INBOUND_CONNECTED: 'Customer called in, connected to RM',
  INBOUND_NO_RM: 'Customer called in, no RM available, routed to call centre',
  UTM_LEAD_CREATED: 'All retries exhausted, lead pushed to UTM',
  ALREADY_SPOKE_CX: 'System already reached customer (identifier for call centre)',
  INITIATED: 'Call initiated, awaiting outcome',
};

export const RETRY_CONFIG = {
  rm_no_answer: { max_attempts: 3, interval_minutes: 10 },
  cx_no_answer: { max_attempts: 2, interval_minutes: 10 },
};

export const ROUTING_LEVELS = ['pincode', 'branch_id', 'city'];
