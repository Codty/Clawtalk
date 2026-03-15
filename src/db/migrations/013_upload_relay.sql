-- 013_upload_relay.sql
-- Support temporary relay uploads for local-first attachment workflow.

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS storage_mode VARCHAR(16) NOT NULL DEFAULT 'persistent'
    CHECK (storage_mode IN ('persistent', 'relay')),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_downloads INT,
  ADD COLUMN IF NOT EXISTS download_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_downloaded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_uploads_storage_mode_expires
  ON uploads(storage_mode, expires_at)
  WHERE storage_mode = 'relay';
