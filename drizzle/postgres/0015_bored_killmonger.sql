ALTER TABLE "ssh_data" ADD COLUMN "enable_ard" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "ard_port" integer DEFAULT 5900;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "ard_credential_id" integer;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "ard_password" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "ard_user" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "ard_auth_type" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD CONSTRAINT "ssh_data_ard_credential_id_ssh_credentials_id_fk" FOREIGN KEY ("ard_credential_id") REFERENCES "public"."ssh_credentials"("id") ON DELETE set null ON UPDATE no action;