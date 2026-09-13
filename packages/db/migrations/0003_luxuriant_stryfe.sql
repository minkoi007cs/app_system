CREATE TABLE "infra_platform_admins" (
	"user_id" text PRIMARY KEY NOT NULL,
	"role" varchar(24) DEFAULT 'super_admin' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"mfa_required_since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_mfa_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" varchar(16) NOT NULL,
	"label" varchar(64) NOT NULL,
	"encrypted_secret" text,
	"encryption_iv" varchar(24),
	"encryption_auth_tag" varchar(32),
	"encryption_key_version" integer DEFAULT 1,
	"backup_code_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_id" text,
	"public_key" text,
	"sign_count" integer DEFAULT 0,
	"transports" jsonb,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"device_hash" varchar(64) NOT NULL,
	"label" varchar(96),
	"trusted_until" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "infra_platform_admins" ADD CONSTRAINT "infra_platform_admins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_mfa_factors" ADD CONSTRAINT "infra_mfa_factors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_trusted_devices" ADD CONSTRAINT "infra_trusted_devices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_mfa_user_idx" ON "infra_mfa_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "infra_mfa_credential_idx" ON "infra_mfa_factors" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "infra_trusted_devices_user_idx" ON "infra_trusted_devices" USING btree ("user_id");