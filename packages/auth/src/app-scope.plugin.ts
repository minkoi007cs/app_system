/**
 * App scoping.
 *
 * A person is ONE global identity (one email = one user). Which child apps they belong to
 * is decided by infra_app_members, and the session carries the app it is currently acting in.
 *
 * Security rule: server code takes appId from the API key, never from client input.
 */
import type { BetterAuthPlugin } from 'better-auth';

export const APP_SCOPE_PLUGIN_ID = 'infra-app-scope';

export function appScopePlugin(): BetterAuthPlugin {
  return {
    id: APP_SCOPE_PLUGIN_ID,
    /**
     * No `fieldName` here, deliberately — and this is not a style choice.
     *
     * Better Auth's Drizzle adapter addresses a column by the **property key** of the Drizzle
     * table object, not by the column's name in the database. Its own schema check says as much:
     * "each column by its property name". Our schema declares
     * `activeAppId: uuid('active_app_id')`, so the key is `activeAppId` and the database column
     * is `active_app_id`.
     *
     * Setting `fieldName: 'active_app_id'` told Better Auth to look for a property literally
     * named `active_app_id`. There is none. The adapter then refused to start at all, with
     * `SCHEMA_MISMATCH · missing-column session.active_app_id` — even though that column exists
     * both in the database and in the Drizzle schema. Nothing was misnamed; only the layer doing
     * the lookup disagreed about which name it was looking up.
     *
     * The consequence was not a warning. `auth().api.signInEmail` threw, and
     * `/api/v1/auth/token` catches every failure from it and answers **401 "invalid email or
     * password"** — by design, so that an unknown email and a wrong password are
     * indistinguishable. So a total failure of email/password sign-in wore the costume of a
     * wrong password, for every user, with nothing in the response to tell them apart.
     *
     * Drizzle already owns the column naming, and the adapter reads the real column name off the
     * column object when it builds SQL. The property key is all Better Auth needs from us.
     */
    schema: {
      session: {
        fields: {
          activeAppId: {
            type: 'string',
            required: false,
            input: false,
          },
          /** Set by the MFA challenge; admin routes refuse a stale value. */
          mfaVerifiedAt: {
            type: 'date',
            required: false,
            input: false,
          },
        },
      },
    },
  } satisfies BetterAuthPlugin;
}
