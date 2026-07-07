-- Centralized outbound email log for review, delivery tracking, and resend.
CREATE TABLE IF NOT EXISTS sent_emails (
  id SERIAL PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'eod-api',
  source_type TEXT NOT NULL,
  source_ref TEXT,
  resend_id TEXT UNIQUE,
  parent_id INTEGER REFERENCES sent_emails(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_status TEXT,
  last_event TEXT,
  last_event_at TIMESTAMPTZ,
  from_address TEXT,
  to_addresses TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses TEXT[] NOT NULL DEFAULT '{}',
  bcc_addresses TEXT[] NOT NULL DEFAULT '{}',
  reply_to TEXT,
  subject TEXT,
  html_body TEXT,
  text_body TEXT,
  attachments JSONB NOT NULL DEFAULT '[]',
  stored_payload JSONB NOT NULL DEFAULT '{}',
  resend_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  error_message TEXT,
  sent_by_email TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sent_emails_created_at ON sent_emails (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sent_emails_status ON sent_emails (status);
CREATE INDEX IF NOT EXISTS idx_sent_emails_delivery_status ON sent_emails (delivery_status);
CREATE INDEX IF NOT EXISTS idx_sent_emails_source_system ON sent_emails (source_system);
CREATE INDEX IF NOT EXISTS idx_sent_emails_source_type ON sent_emails (source_type);
