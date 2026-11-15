-- SQLite cannot add a NOT NULL column without a constant default, so last_seen_at
-- gets the epoch default and existing sessions are backfilled from created_at.
ALTER TABLE `sessions` ADD `last_seen_at` text NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';--> statement-breakpoint
UPDATE `sessions` SET `last_seen_at` = `created_at`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `prev_token_hash` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `rotated_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_prev_token_hash_unique` ON `sessions` (`prev_token_hash`);
