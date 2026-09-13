CREATE TABLE "infra_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"family_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"app_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(24),
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "infra_api_keys" ADD COLUMN "key_type" varchar(16) DEFAULT 'secret' NOT NULL;--> statement-breakpoint
ALTER TABLE "infra_refresh_tokens" ADD CONSTRAINT "infra_refresh_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_refresh_tokens" ADD CONSTRAINT "infra_refresh_tokens_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_rt_family_idx" ON "infra_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "infra_rt_user_app_idx" ON "infra_refresh_tokens" USING btree ("user_id","app_id");--> statement-breakpoint
CREATE INDEX "infra_rt_session_idx" ON "infra_refresh_tokens" USING btree ("session_id");