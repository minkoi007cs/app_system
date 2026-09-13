CREATE TABLE "infra_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" varchar(16) DEFAULT 'member' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"revoked_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "infra_user_lifecycle" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"reason" text,
	"changed_by" text,
	"suspended_at" timestamp with time zone,
	"offboarded_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"name" varchar(96) NOT NULL,
	"description" text,
	"owner_user_id" text NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"ip_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "infra_api_keys" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "infra_invitations" ADD CONSTRAINT "infra_invitations_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_user_lifecycle" ADD CONSTRAINT "infra_user_lifecycle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_service_accounts" ADD CONSTRAINT "infra_service_accounts_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_invitations_app_idx" ON "infra_invitations" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "infra_invitations_hash_idx" ON "infra_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "infra_service_accounts_app_idx" ON "infra_service_accounts" USING btree ("app_id");