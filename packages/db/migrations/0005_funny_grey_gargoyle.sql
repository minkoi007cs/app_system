CREATE TABLE "infra_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"resource" varchar(64) NOT NULL,
	"action" varchar(16) NOT NULL,
	"effect" varchar(8) NOT NULL,
	"condition" jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" varchar(16) NOT NULL,
	"subject_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"scope_id" text,
	"expires_at" timestamp with time zone,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid,
	"key" varchar(48) NOT NULL,
	"name" varchar(96) NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(16) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "infra_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" varchar(128) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "infra_policies" ADD CONSTRAINT "infra_policies_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_role_assignments" ADD CONSTRAINT "infra_role_assignments_role_id_infra_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."infra_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_roles" ADD CONSTRAINT "infra_roles_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_workspace_members" ADD CONSTRAINT "infra_workspace_members_workspace_id_infra_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."infra_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_workspace_members" ADD CONSTRAINT "infra_workspace_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_workspaces" ADD CONSTRAINT "infra_workspaces_app_id_infra_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."infra_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_policies_app_resource_idx" ON "infra_policies" USING btree ("app_id","resource","action");--> statement-breakpoint
CREATE INDEX "infra_ra_subject_idx" ON "infra_role_assignments" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "infra_ra_scope_idx" ON "infra_role_assignments" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "infra_roles_app_key_idx" ON "infra_roles" USING btree ("app_id","key");--> statement-breakpoint
CREATE INDEX "infra_ws_members_user_idx" ON "infra_workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "infra_ws_app_slug_idx" ON "infra_workspaces" USING btree ("app_id","slug");