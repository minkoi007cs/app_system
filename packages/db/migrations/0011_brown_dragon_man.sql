CREATE TABLE "infra_rate_limits" (
	"bucket" varchar(64) PRIMARY KEY NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "infra_rate_limits_window_idx" ON "infra_rate_limits" USING btree ("window_ends_at");