-- Open/click tracking for sent_emails, driven by Resend webhook events
-- (email.opened / email.clicked). Kept separate from delivery_status so an
-- "opened" or "clicked" event never clobbers the delivered/failed/complained
-- state — a message can be both "delivered" and "opened".

ALTER TABLE sent_emails
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS open_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sent_emails_opened_at ON sent_emails (opened_at);
