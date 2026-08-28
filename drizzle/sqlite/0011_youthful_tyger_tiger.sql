ALTER TABLE `ssh_data` ADD `enable_ard` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_port` integer DEFAULT 5900;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_credential_id` integer REFERENCES ssh_credentials(id);--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_password` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_user` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_auth_type` text;