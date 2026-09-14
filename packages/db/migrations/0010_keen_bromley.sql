CREATE TABLE "infra_impersonation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_admin_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"app_id" uuid,
	"reason" text NOT NULL,
	"ticket_ref" varchar(128),
	"read_only" boolean DEFAULT true NOT NULL,
	"ip_address" varchar(45),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" varchar(16)
);
--> statement-breakpoint
ALTER TABLE "infra_impersonation_sessions" ADD CONSTRAINT "infra_impersonation_sessions_actor_admin_id_user_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_impersonation_sessions" ADD CONSTRAINT "infra_impersonation_sessions_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_impersonation_sessions" ADD CONSTRAINT "infra_impersonation_sessions_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_impersonation_actor_idx" ON "infra_impersonation_sessions" USING btree ("actor_admin_id","started_at");--> statement-breakpoint
CREATE INDEX "infra_impersonation_target_idx" ON "infra_impersonation_sessions" USING btree ("target_user_id","started_at");--> statement-breakpoint
CREATE INDEX "infra_impersonation_active_idx" ON "infra_impersonation_sessions" USING btree ("ended_at","expires_at");