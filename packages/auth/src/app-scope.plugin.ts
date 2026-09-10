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
    schema: {
      session: {
        fields: {
          activeAppId: {
            type: 'string',
            required: false,
            input: false,
            fieldName: 'active_app_id',
          },
        },
      },
    },
  } satisfies BetterAuthPlugin;
}
