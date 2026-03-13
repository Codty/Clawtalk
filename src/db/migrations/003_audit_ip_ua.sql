-- 003_audit_ip_ua.sql
-- Add IP address and user agent to audit logs for security observability.

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip VARCHAR(45);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent VARCHAR(512);

-- Rollback:
-- ALTER TABLE audit_logs DROP COLUMN IF EXISTS ip;
-- ALTER TABLE audit_logs DROP COLUMN IF EXISTS user_agent;
