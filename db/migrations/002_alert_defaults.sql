-- Phase 4: alert delivery — new chats get every alert unless they raise their bar with /alerts
ALTER TABLE subscriptions ALTER COLUMN min_severity SET DEFAULT 'info';
