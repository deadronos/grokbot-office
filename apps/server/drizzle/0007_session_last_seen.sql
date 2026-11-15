-- SQLite cannot add a NOT NULL column without a constant default, so the column gets
-- the epoch default and existing sessions are backfilled from `created_at` right after.
ALTER TABLE `sessions` ADD `last_seen_at` text NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';--> statement-breakpoint
UPDATE `sessions` SET `last_seen_at` = `created_at`;
