-- Migration 001: Initial schema
-- Run: psql $DATABASE_URL -f this_file.sql

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-----------------------------------------------------
-- AGENTS
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id           VARCHAR(50) NOT NULL,
    agent_email         VARCHAR(255) NOT NULL UNIQUE,
    agent_name          VARCHAR(255) NOT NULL,
    agent_phone         VARCHAR(15) NOT NULL,
    city                VARCHAR(100) NOT NULL,
    pincode             VARCHAR(10) NOT NULL,
    priority            INT NOT NULL DEFAULT 1,
    city_identifier     VARCHAR(20) NOT NULL DEFAULT 'dont assign',
    pincode_identifier  VARCHAR(20) NOT NULL DEFAULT 'dont assign',
    branch_identifier   VARCHAR(20) NOT NULL DEFAULT 'dont assign',
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_city ON agents(city, city_identifier, priority) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_agents_pincode ON agents(pincode, pincode_identifier, priority) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_agents_branch ON agents(branch_id, branch_identifier, priority) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_agents_email ON agents(agent_email);

-----------------------------------------------------
-- ROUTING_CONFIG (global settings)
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS routing_config (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                        VARCHAR(100) NOT NULL DEFAULT 'default',
    fallback_call_center_number VARCHAR(15) NOT NULL,
    max_parallel_rms            INT DEFAULT 3,
    rm_ring_duration_sec        INT DEFAULT 20,
    business_hours_start        TIME DEFAULT '09:00',
    business_hours_end          TIME DEFAULT '18:00',
    business_days               JSONB DEFAULT '["mon","tue","wed","thu","fri","sat"]',
    is_active                   BOOLEAN DEFAULT TRUE,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-----------------------------------------------------
-- SOURCE_ROUTING_RULES (per-lead-source routing)
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS source_routing_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_source     VARCHAR(50) NOT NULL UNIQUE,
    routing_level   VARCHAR(20) NOT NULL,
    fallback_levels JSONB DEFAULT '[]',
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-----------------------------------------------------
-- LEADS
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id           VARCHAR(100) NOT NULL UNIQUE,
    customer_name     VARCHAR(255),
    customer_phone    VARCHAR(15) NOT NULL,
    city              VARCHAR(100),
    pincode           VARCHAR(10),
    branch_id         VARCHAR(50),
    loan_type         VARCHAR(50),
    loan_amount       DECIMAL(12,2),
    lead_source       VARCHAR(50) DEFAULT 'chakra',
    status            VARCHAR(30) DEFAULT 'new',
    assigned_rm_phone VARCHAR(15),
    assigned_rm_name  VARCHAR(255),
    connected_at      TIMESTAMPTZ,
    utm_created       BOOLEAN DEFAULT FALSE,
    utm_identifier    VARCHAR(255),
    queued_for        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(customer_phone);
CREATE INDEX IF NOT EXISTS idx_leads_queued ON leads(queued_for) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(lead_source);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

-----------------------------------------------------
-- CALL_LOGS
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS call_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id           VARCHAR(100) NOT NULL,
    call_sid          VARCHAR(100),
    call_type         VARCHAR(20) NOT NULL,
    direction         VARCHAR(20),
    from_number       VARCHAR(15),
    to_number         VARCHAR(15),
    exophone          VARCHAR(15),
    attempt_number    INT DEFAULT 1,
    rm_phones_dialed  JSONB,
    disposition       VARCHAR(50),
    rm_who_answered   VARCHAR(15),
    call_duration_sec INT,
    recording_url     TEXT,
    exotel_status     VARCHAR(50),
    metadata          JSONB,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_lead ON call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_disposition ON call_logs(disposition);
CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs(created_at);

-----------------------------------------------------
-- RETRY_QUEUE
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS retry_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         VARCHAR(100) NOT NULL,
    retry_type      VARCHAR(20) NOT NULL,
    attempt_number  INT NOT NULL,
    max_attempts    INT NOT NULL,
    scheduled_at    TIMESTAMPTZ NOT NULL,
    status          VARCHAR(20) DEFAULT 'pending',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retry_pending ON retry_queue(scheduled_at) WHERE status = 'pending';

-----------------------------------------------------
-- CSV_UPLOADS (audit trail)
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS csv_uploads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename        VARCHAR(255),
    uploaded_by     VARCHAR(255),
    total_rows      INT,
    new_agents      INT,
    updated_agents  INT,
    skipped_agents  INT,
    errors          JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-----------------------------------------------------
-- USERS (dashboard auth)
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    name            VARCHAR(255),
    role            VARCHAR(20) DEFAULT 'viewer',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-----------------------------------------------------
-- DASHBOARD_STATS (precomputed cache)
-----------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_stats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stat_date       DATE NOT NULL,
    stat_hour       INT,
    total_leads     INT DEFAULT 0,
    connected       INT DEFAULT 0,
    rm_no_answer    INT DEFAULT 0,
    cx_no_answer    INT DEFAULT 0,
    call_failed     INT DEFAULT 0,
    utm_created     INT DEFAULT 0,
    queued          INT DEFAULT 0,
    avg_connect_sec DECIMAL(8,2),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(stat_date, stat_hour)
);
