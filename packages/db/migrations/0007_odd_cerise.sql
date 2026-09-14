CREATE TABLE "infra_login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(16) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"first_failure_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failure_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "infra_recovery_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"purpose" varchar(24) DEFAULT 'password_reset' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_ip" varchar(45),
	"consumed_ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_recovery_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "infra_recovery_tokens" ADD CONSTRAINT "infra_recovery_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "infra_login_attempts_key_idx" ON "infra_login_attempts" USING btree ("scope","key_hash");--> statement-breakpoint
CREATE INDEX "infra_login_attempts_last_idx" ON "infra_login_attempts" USING btree ("last_failure_at");--> statement-breakpoint
CREATE UNIQUE INDEX "infra_recovery_hash_idx" ON "infra_recovery_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "infra_recovery_user_idx" ON "infra_recovery_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "infra_recovery_expiry_idx" ON "infra_recovery_tokens" USING btree ("expires_at");