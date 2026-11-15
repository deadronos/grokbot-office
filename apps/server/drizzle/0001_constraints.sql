-- 0001 rebuilds every table: SQLite has no ALTER for CHECK or foreign keys.
-- openDatabase() runs migrations with foreign_keys=OFF because drizzle's migrator
-- keeps the whole run in one transaction; PRAGMA foreign_key_check must stay empty.
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
	CONSTRAINT "events_type_check" CHECK(`type` in ('status_changed', 'task_started', 'task_finished', 'handoff_sent', 'handoff_accepted', 'offline', 'bot_registered')),
	CONSTRAINT "events_status_check" CHECK(`status` is null or `status` in ('idle', 'working', 'waiting', 'reviewing', 'offline')),
	CONSTRAINT "events_result_check" CHECK(`result` is null or `result` in ('done', 'failed', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_events`("seq", "event_id", "bot_id", "type", "status", "label", "ref", "task_id", "handoff_id", "to_bot_id", "result", "client_at", "received_at") SELECT "seq", "event_id", "bot_id", "type", NULL, "label", "ref", "task_id", "handoff_id", "to_bot_id", "result", "client_at", "received_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
CREATE UNIQUE INDEX `events_bot_id_event_id_unique` ON `events` (`bot_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `events_received_at_idx` ON `events` (`received_at`);--> statement-breakpoint
CREATE INDEX `events_bot_id_seq_idx` ON `events` (`bot_id`,`seq`);--> statement-breakpoint
CREATE TABLE `__new_bot_status` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`label` text,
	`task_id` text,
	`handoff_to` text,
	`since` text NOT NULL,
	`last_heartbeat_at` text NOT NULL,
	`last_event_seq` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handoff_to`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bot_status_status_check" CHECK(`status` in ('idle', 'working', 'waiting', 'reviewing', 'offline'))
);
--> statement-breakpoint
INSERT INTO `__new_bot_status`("bot_id", "status", "label", "task_id", "handoff_to", "since", "last_heartbeat_at", "last_event_seq") SELECT "bot_id", "status", "label", "task_id", "handoff_to", "since", "last_heartbeat_at", "last_event_seq" FROM `bot_status`;--> statement-breakpoint
DROP TABLE `bot_status`;--> statement-breakpoint
ALTER TABLE `__new_bot_status` RENAME TO `bot_status`;--> statement-breakpoint
CREATE INDEX `bot_status_last_heartbeat_at_idx` ON `bot_status` (`last_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `__new_bots` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`avatar` text NOT NULL,
	`pod` text NOT NULL,
	`desk_index` integer,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "bots_pod_check" CHECK(`pod` in ('command', 'dev', 'ops'))
);
--> statement-breakpoint
INSERT INTO `__new_bots`("id", "name", "role", "avatar", "pod", "desk_index", "hidden", "created_at", "updated_at") SELECT "id", "name", "role", "avatar", "pod", "desk_index", "hidden", "created_at", "updated_at" FROM `bots`;--> statement-breakpoint
DROP TABLE `bots`;--> statement-breakpoint
ALTER TABLE `__new_bots` RENAME TO `bots`;--> statement-breakpoint
CREATE TABLE `__new_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`from_bot_id` text NOT NULL,
	`to_bot_id` text NOT NULL,
	`label` text,
	`state` text NOT NULL,
	`sent_at` text NOT NULL,
	`accepted_at` text,
	FOREIGN KEY (`from_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "handoffs_state_check" CHECK(`state` in ('sent', 'accepted', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_handoffs`("id", "from_bot_id", "to_bot_id", "label", "state", "sent_at", "accepted_at") SELECT "id", "from_bot_id", "to_bot_id", "label", "state", "sent_at", "accepted_at" FROM `handoffs`;--> statement-breakpoint
DROP TABLE `handoffs`;--> statement-breakpoint
ALTER TABLE `__new_handoffs` RENAME TO `handoffs`;--> statement-breakpoint
CREATE INDEX `handoffs_to_bot_id_state_idx` ON `handoffs` (`to_bot_id`,`state`);--> statement-breakpoint
CREATE TABLE `__new_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`bot_id` text,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tokens_kind_check" CHECK(`kind` in ('admin', 'bot', 'viewer'))
);
--> statement-breakpoint
INSERT INTO `__new_tokens`("id", "kind", "bot_id", "prefix", "hash", "created_at", "last_used_at", "revoked_at") SELECT "id", "kind", "bot_id", "prefix", "hash", "created_at", "last_used_at", "revoked_at" FROM `tokens`;--> statement-breakpoint
DROP TABLE `tokens`;--> statement-breakpoint
ALTER TABLE `__new_tokens` RENAME TO `tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_hash_unique` ON `tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `tokens_bot_id_idx` ON `tokens` (`bot_id`);