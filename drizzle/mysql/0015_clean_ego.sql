ALTER TABLE `ssh_data` ADD `enable_ard` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_port` int DEFAULT 5900;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_credential_id` int;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_password` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_user` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `ard_auth_type` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD CONSTRAINT `ssh_data_ard_credential_id_ssh_credentials_id_fk` FOREIGN KEY (`ard_credential_id`) REFERENCES `ssh_credentials`(`id`) ON DELETE set null ON UPDATE no action;