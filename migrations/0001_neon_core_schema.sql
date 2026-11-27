-- TIN LAB Phase 1 (Cloudflare Workers + Neon PostgreSQL Free)
-- Safe, idempotent, non-destructive schema migration.
-- NEVER drops tables, NEVER truncates data, NEVER runs destructive column alterations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Core table: student exam attempts, answers, scores, and teacher review metadata
CREATE TABLE IF NOT EXISTS exam_attempts (
  id SERIAL PRIMARY KEY,
  attempt_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  exam_id TEXT NOT NULL,
  exam_title TEXT NOT NULL,
  exam_kind TEXT NOT NULL DEFAULT 'published',
  access_code TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL,
  student_name_normalized TEXT NOT NULL,
  class_name TEXT NOT NULL,
  raw_class_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  completion_status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (completion_status IN ('in_progress', 'auto_graded', 'needs_review', 'reviewed')),
  scoring_mode TEXT NOT NULL DEFAULT 'tiered_2025',
  part1_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  part1_max DOUBLE PRECISION NOT NULL DEFAULT 0,
  part2_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  part2_max DOUBLE PRECISION NOT NULL DEFAULT 0,
  part3_score DOUBLE PRECISION,
  part3_max DOUBLE PRECISION NOT NULL DEFAULT 0,
  score DOUBLE PRECISION,
  max_score DOUBLE PRECISION NOT NULL DEFAULT 10,
  detailed_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  admin_feedback TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance indexes for 10–40+ concurrent students and Super Admin filtering/reporting
CREATE INDEX IF NOT EXISTS exam_attempts_class_name_idx
  ON exam_attempts (class_name);

CREATE INDEX IF NOT EXISTS exam_attempts_exam_id_idx
  ON exam_attempts (exam_id);

CREATE INDEX IF NOT EXISTS exam_attempts_started_at_idx
  ON exam_attempts (started_at DESC);

CREATE INDEX IF NOT EXISTS exam_attempts_completion_status_idx
  ON exam_attempts (completion_status);

CREATE INDEX IF NOT EXISTS exam_attempts_class_exam_started_idx
  ON exam_attempts (class_name, exam_id, started_at DESC);

-- 2. Governance & user directory tables (kept schema-compatible with Phase 2 / Cloud SQL)
CREATE TABLE IF NOT EXISTS role_definitions (
  role TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'student',
  role_source TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'active',
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_authorizations (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  assigned_role TEXT NOT NULL DEFAULT 'super_admin',
  status TEXT NOT NULL DEFAULT 'pending_activation',
  is_bootstrap BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT NOT NULL DEFAULT '',
  granted_by_uid TEXT NOT NULL DEFAULT 'system',
  granted_by_email TEXT NOT NULL DEFAULT 'system',
  activated_uid TEXT,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  actor_uid TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_email TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
