-- Optional explicit recipient on hub messages (addressee).

ALTER TABLE hub_messages
  ADD COLUMN IF NOT EXISTS recipient_id INTEGER REFERENCES hub_users(id);

CREATE INDEX IF NOT EXISTS idx_hub_messages_recipient ON hub_messages (recipient_id);
