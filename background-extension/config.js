export const API_BASE_URL = "https://joybuy-price-history.zhangmeng43.workers.dev";

export const MAX_PAGES_PER_TARGET = 500;
export const STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES = 1;
export const PAGES_PER_ALARM_TICK = 80;
export const PAGE_FETCH_CONCURRENCY = 8;
export const PAGE_FETCH_TIMEOUT_MS = 20000;
export const PAGE_DELAY_MS = 100;
export const OBSERVATION_DELAY_MS = 10;
export const WRITE_UNCHANGED_OBSERVATIONS = false;
export const BATCH_FLUSH_SIZE = 500;
export const SNAPSHOT_SAVE_INTERVAL_PAGES = 500;
export const STREAM_EARLY_ABORT_ENABLED = true;
export const STREAM_MIN_BYTES = 32768;
export const STREAM_FULL_READ_FALLBACK_BYTES = 786432;
export const MAX_PAGE_RETRIES = 3;
export const RETRY_DELAY_MS = 60000;
