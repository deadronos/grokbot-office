PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text,
	`label` text,
	`ref` text,
	`task_id` text,
	`handoff_id` text,
	`to_bot_id` text,
	`result` text,
	`client_at` text,
	`received_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handoff_id`) REFERENCES `handoffs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_type_check" CHECK(`type` in ('status_changed', 'task_started', 'task_finished', 'handoff_sent', 'handoff_accepted', 'offline', 'bot_registered', 'bot_hidden')),
	CONSTRAINT "events_status_check" CHECK(`status` is null or `status` in ('idle', 'working', 'waiting', 'reviewing', 'offline')),
	CONSTRAINT "events_result_check" CHECK(`result` is null or `result` in ('done', 'failed', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_events`("seq", "event_id", "bot_id", "type", "status", "label", "ref", "task_id", "handoff_id", "to_bot_id", "result", "client_at", "received_at") SELECT "seq", "event_id", "bot_id", "type", "status", "label", "ref", "task_id", "handoff_id", "to_bot_id", "result", "client_at", "received_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `events_bot_id_event_id_unique` ON `events` (`bot_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `events_received_at_idx` ON `events` (`received_at`);--> statement-breakpoint
CREATE INDEX `events_bot_id_seq_idx` ON `events` (`bot_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_bot_id_type_handoff_id_idx` ON `events` (`bot_id`,`type`,`handoff_id`);--> statement-breakpoint
CREATE INDEX `events_handoff_id_idx` ON `events` (`handoff_id`);