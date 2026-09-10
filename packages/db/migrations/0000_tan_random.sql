CREATE TABLE "infra_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"owner_user_id" text NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "infra_apps_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "infra_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"key_prefix" varchar(20) NOT NULL,
	"environment" varchar(8) DEFAULT 'live' NOT NULL,
	"scopes" jsonb DEFAULT '["db:read"]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "infra_database_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"provider" varchar(16) NOT NULL,
	"dialect" varchar(16) NOT NULL,
	"label" varchar(128) NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"encrypted_connection_string" text NOT NULL,
	"encryption_iv" varchar(24) NOT NULL,
	"encryption_auth_tag" varchar(32) NOT NULL,
	"encryption_key_version" integer DEFAULT 1 NOT NULL,
	"host_hint" varchar(255),
	"pool_max" integer DEFAULT 3 NOT NULL,
	"health_status" varchar(16) DEFAULT 'unknown' NOT NULL,
	"health_latency_ms" integer,
	"health_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" text,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32),
	"target_id" text,
	"outcome" varchar(16) DEFAULT 'success' NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_app_members" (
	"app_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(16) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_app_members_app_id_user_id_pk" PRIMARY KEY("app_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"active_app_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "infra_api_keys" ADD CONSTRAINT "infra_api_keys_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_database_configs" ADD CONSTRAINT "infra_database_configs_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_audit_logs" ADD CONSTRAINT "infra_audit_logs_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_app_members" ADD CONSTRAINT "infra_app_members_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_app_members" ADD CONSTRAINT "infra_app_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_active_app_id_infra_apps_id_fk" FOREIGN KEY ("active_app_id") REFERENCES "public"."infra_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_apps_owner_idx" ON "infra_apps" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "infra_apps_status_idx" ON "infra_apps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "infra_api_keys_app_idx" ON "infra_api_keys" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "infra_api_keys_hash_idx" ON "infra_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "infra_db_configs_app_idx" ON "infra_database_configs" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "infra_db_configs_one_primary" ON "infra_database_configs" USING btree ("app_id") WHERE "infra_database_configs"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "infra_audit_app_time_idx" ON "infra_audit_logs" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "infra_audit_action_idx" ON "infra_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "infra_app_members_user_idx" ON "infra_app_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");