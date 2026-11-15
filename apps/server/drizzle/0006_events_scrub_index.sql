CREATE INDEX `events_bot_id_type_handoff_id_idx` ON `events` (`bot_id`,`type`,`handoff_id`);--> statement-breakpoint
CREATE INDEX `events_handoff_id_idx` ON `events` (`handoff_id`);