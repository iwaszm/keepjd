CREATE TABLE IF NOT EXISTS collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  targets INTEGER NOT NULL DEFAULT 0,
  targets_done INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  observations_found INTEGER NOT NULL DEFAULT 0,
  observations_written INTEGER NOT NULL DEFAULT 0,
  observations_skipped INTEGER NOT NULL DEFAULT 0,
  stopped_reason TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS collector_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  target_index INTEGER NOT NULL,
  label TEXT,
  url TEXT NOT NULL,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  observations_found INTEGER NOT NULL DEFAULT 0,
  observations_written INTEGER NOT NULL DEFAULT 0,
  observations_skipped INTEGER NOT NULL DEFAULT 0,
  done_reason TEXT,
  last_page TEXT,
  last_error TEXT,
  FOREIGN KEY (run_id) REFERENCES collector_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_collector_runs_started_at
  ON collector_runs(started_at);

CREATE INDEX IF NOT EXISTS idx_collector_run_items_run_id
  ON collector_run_items(run_id);

CREATE TABLE IF NOT EXISTS collector_target_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_started_at TEXT NOT NULL,
  run_finished_at TEXT,
  target_index INTEGER,
  original_target_index INTEGER,
  label TEXT,
  url TEXT NOT NULL,
  configured_max_page INTEGER,
  latest_max_page INTEGER,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  zero_product_pages INTEGER NOT NULL DEFAULT 0,
  forbidden_pages INTEGER NOT NULL DEFAULT 0,
  items_found INTEGER NOT NULL DEFAULT 0,
  posted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  done_reason TEXT,
  last_page TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_collector_target_stats_url_created
  ON collector_target_stats(url, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_collector_target_stats_run_started
  ON collector_target_stats(run_started_at);
