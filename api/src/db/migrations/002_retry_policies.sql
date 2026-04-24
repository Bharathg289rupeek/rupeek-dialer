-- Migration 002: Configurable retry policies + new statuses
-- Safe to re-run. Uses IF NOT EXISTS / IF EXISTS guards throughout.

-- 1. Add per-disposition retry config columns to routing_config
ALTER TABLE routing_config
  ADD COLUMN IF NOT EXISTS cx_not_picked_max_attempts       INT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS cx_not_picked_interval_min       INT DEFAULT 10,
  ADD COLUMN IF NOT EXISTS cx_drop_voicebot_max_attempts    INT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS cx_drop_voicebot_interval_min    INT DEFAULT 10,
  ADD COLUMN IF NOT EXISTS callcenter_no_answer_max_attempts INT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS callcenter_no_answer_interval_min INT DEFAULT 10,
  ADD COLUMN IF NOT EXISTS call_failed_max_attempts         INT DEFAULT 3,
  ADD COLUMN IF NOT EXISTS call_failed_interval_min         INT DEFAULT 5;

-- 2. Backfill defaults for any existing rows that have NULLs
UPDATE routing_config SET
  cx_not_picked_max_attempts        = COALESCE(cx_not_picked_max_attempts, 2),
  cx_not_picked_interval_min        = COALESCE(cx_not_picked_interval_min, 10),
  cx_drop_voicebot_max_attempts     = COALESCE(cx_drop_voicebot_max_attempts, 2),
  cx_drop_voicebot_interval_min     = COALESCE(cx_drop_voicebot_interval_min, 10),
  callcenter_no_answer_max_attempts = COALESCE(callcenter_no_answer_max_attempts, 2),
  callcenter_no_answer_interval_min = COALESCE(callcenter_no_answer_interval_min, 10),
  call_failed_max_attempts          = COALESCE(call_failed_max_attempts, 3),
  call_failed_interval_min          = COALESCE(call_failed_interval_min, 5);

-- 3. Migrate any historical leads that used to be 'utm_created' to 'failed'
--    (UTM logic has been removed entirely. Leads that previously got UTM
--     treatment are now terminal 'failed' so they stop showing in
--     stat cards that no longer exist.)
UPDATE leads SET status = 'failed', updated_at = NOW()
 WHERE status = 'utm_created';
