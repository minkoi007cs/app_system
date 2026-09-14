CREATE TABLE "infra_provider_quotas" (
	"provider" varchar(16) PRIMARY KEY NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"quota_limit" integer,
	"last_error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_provisioned_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid,
	"provider" varchar(16) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"region" varchar(64),
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"last_error" varchar(255),
	"release_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "infra_provisioned_resources" ADD CONSTRAINT "infra_provisioned_resources_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_provisioned_app_idx" ON "infra_provisioned_resources" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "infra_provisioned_state_idx" ON "infra_provisioned_resources" USING btree ("state","provider");