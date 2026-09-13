CREATE TABLE "infra_signing_keys" (
	"kid" varchar(32) PRIMARY KEY NOT NULL,
	"algorithm" varchar(16) DEFAULT 'ES256' NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"encryption_iv" varchar(24) NOT NULL,
	"encryption_auth_tag" varchar(32) NOT NULL,
	"encryption_key_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"retires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "infra_signing_keys_status_idx" ON "infra_signing_keys" USING btree ("status");