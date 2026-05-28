-- Checklane Hub — visit-scoped rep↔lead chat threads.

CREATE TABLE IF NOT EXISTS hub_message_threads (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  rep_id INTEGER NOT NULL REFERENCES hub_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visit_id, rep_id)
);

CREATE TABLE IF NOT EXISTS hub_messages (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES hub_message_threads(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES hub_users(id),
  body TEXT NOT NULL,
  dbkey TEXT,
  message_type TEXT NOT NULL DEFAULT 'chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hub_message_reads (
  thread_id INTEGER NOT NULL REFERENCES hub_message_threads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES hub_users(id),
  last_read_message_id INTEGER REFERENCES hub_messages(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_hub_message_threads_visit ON hub_message_threads (visit_id);
CREATE INDEX IF NOT EXISTS idx_hub_messages_thread_created ON hub_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hub_messages_thread_id ON hub_messages (thread_id, id);
