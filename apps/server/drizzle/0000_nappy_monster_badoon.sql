CREATE TABLE `bot_status` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`label` text,
	`task_id` text,
	`handoff_to` text,
	`since` text NOT NULL,
	`last_heartbeat_at` text NOT NULL,
	`last_event_seq` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handoff_to`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bot_status_last_heartbeat_at_idx` ON `bot_status` (`last_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`avatar` text NOT NULL,
	`pod` text NOT NULL,
	`desk_index` integer NOT NULL,
	`hidden` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`ref` text,
	`task_id` text,
	`handoff_id` text,
	`to_bot_id` text,
	`result` text,
	`client_at` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_bot_id_event_id_unique` ON `events` (`bot_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `events_received_at_idx` ON `events` (`received_at`);--> statement-breakpoint
CREATE INDEX `events_bot_id_seq_idx` ON `events` (`bot_id`,`seq`);--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`from_bot_id` text NOT NULL,
	`to_bot_id` text NOT NULL,
	`label` text NOT NULL,
	`state` text NOT NULL,
	`sent_at` text NOT NULL,
	`accepted_at` text,
	FOREIGN KEY (`from_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `handoffs_to_bot_id_state_idx` ON `handoffs` (`to_bot_id`,`state`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`bot_id` text,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_hash_unique` ON `tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `tokens_bot_id_idx` ON `tokens` (`bot_id`);