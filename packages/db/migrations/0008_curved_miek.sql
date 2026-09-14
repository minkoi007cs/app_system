CREATE TABLE "infra_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"event_id" varchar(64) NOT NULL,
	"event_type" varchar(48) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" varchar(255),
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" varchar(255),
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"encrypted_secret" text NOT NULL,
	"encryption_iv" varchar(24) NOT NULL,
	"encryption_auth_tag" varchar(32) NOT NULL,
	"encryption_key_version" integer DEFAULT 1 NOT NULL,
	"disabled_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "infra_webhook_deliveries" ADD CONSTRAINT "infra_webhook_deliveries_endpoint_id_infra_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."infra_webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_webhook_deliveries" ADD CONSTRAINT "infra_webhook_deliveries_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_webhook_endpoints" ADD CONSTRAINT "infra_webhook_endpoints_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_webhook_deliveries_due_idx" ON "infra_webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "infra_webhook_deliveries_endpoint_idx" ON "infra_webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "infra_webhook_endpoints_app_idx" ON "infra_webhook_endpoints" USING btree ("app_id","status");