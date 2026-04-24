// Lead lifecycle statuses.
// 'cx_notpicked_retrying' = intermediate state while the system re-tries a
// customer that has not been reached. Count of attempts tracked on the
// retry_queue rows for that lead.
// 'call_center_handled' = Exotel's applet-level fallback call centre picked up.
// 'utm_created' is retained ONLY as a historical value for old rows — never
// written by the current code (the UTM path was removed).
export const LEAD_STATUSES = [
  'new',
  'in_progress',
  'cx_notpicked_retrying',
  'connected',
  'call_center_handled',
  'queued',
  'failed',
  'utm_created',
];

export const DISPOSITIONS = {
  RM_CONNECTED:             'RM picked up and spoke with the customer',
  RM_NO_ANSWER_CALLCENTER:  'No RM answered; Exotel call-centre fallback picked up',
  CALLCENTER_NO_ANSWER:     'Call was routed to call centre but call centre did not pick up either',
  CUSTOMER_NOT_PICKED:      'Customer did not answer the outbound call',
  CX_DROP_VOICEBOT:         'Customer disconnected during the voicebot greeting',
  CALL_FAILED:              'Technical failure — network / Exotel API error',
  INVALID_NUMBER:           'Customer phone number is invalid or unreachable',
  INBOUND_CONNECTED:        'Customer called in and reached an RM',
  INBOUND_NO_RM:            'Customer called in but no RM available',
  INITIATED:                'Call initiated — awaiting outcome',
};

// Retry policy defaults. Actual values are read from routing_config at run-time;
// these are the fallbacks if the DB row has NULLs.
export const RETRY_CONFIG_DEFAULTS = {
  cx_not_picked:         { max_attempts: 2, interval_minutes: 10 },
  cx_drop_voicebot:      { max_attempts: 2, interval_minutes: 10 },
  callcenter_no_answer:  { max_attempts: 2, interval_minutes: 10 },
  call_failed:           { max_attempts: 3, interval_minutes: 5 },
};

// WhatsApp tags. Every terminal WhatsApp notification carries one of these.
export const WA_TAGS = {
  ALREADY_CALLED: 'already_called', // customer spoke to someone (RM)
  NOT_CALLED:     'not_called',     // customer did not reach anyone
};

export const ROUTING_LEVELS = ['pincode', 'branch_id', 'city'];
