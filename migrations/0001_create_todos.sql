CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'spark',
  emoji TEXT NOT NULL DEFAULT '✨',
  attachment_key TEXT,
  attachment_name TEXT,
  attachment_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_todos_completed_created
ON todos (completed, created_at DESC);
