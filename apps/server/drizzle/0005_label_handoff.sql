ALTER TABLE `bot_status` ADD `label_handoff_id` text REFERENCES handoffs(id);--> statement-breakpoint
-- Backfill for labels written before this migration: a receiver's label that equals the
-- label of a handoff it accepted is attributed to the latest such handoff. Matching the
-- text can only over-attribute, and the read-time scrub then hides exactly that text
-- while the sender is hidden, which is the safe direction.
UPDATE `bot_status` SET `label_handoff_id` = (
	SELECT `h`.`id` FROM `handoffs` `h`
	WHERE `h`.`to_bot_id` = `bot_status`.`bot_id`
		AND `h`.`state` = 'accepted'
		AND `h`.`label` = `bot_status`.`label`
	ORDER BY `h`.`accepted_at` DESC, `h`.`id` DESC
	LIMIT 1
) WHERE `label` IS NOT NULL;
