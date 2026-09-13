/**
 * Passkeys (WebAuthn).
 *
 * This is the one place in the identity plane that leans on a library rather than node:crypto.
 * The line is deliberate: JWT and TOTP are each ~60 lines of well-specified maths with official
 * test vectors to check against. WebAuthn means CBOR decoding, COSE keys and a family of
 * attestation formats — writing that by hand is how verification bugs are born.
 *
 * What this module still owns, because a library cannot decide it for you:
 *   · challenges live server-side and are single-use
 *   · the expected origin and RP ID come from configuration, never from the request
 *   · a signature counter that goes backwards disables the credential (cloned authenticator)
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { InfraError } from '@infra/core';
import {
  consumeChallenge,
  findPasskeyByCredentialId,
  listPasskeys,
  savePasskey,
  storeChallenge,
  updatePasskeyCounter,
  type MasterDatabase,
} from '@infra/db';

export type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export interface RelyingParty {
  /** Domain only — no scheme, no port. */
  id: string;
  name: string;
  /** Full origin(s) the browser will report. */
  origin: string | string[];
}

/** Derives the RP settings from the public URL, so dev and prod each just work. */
export function relyingPartyFrom(publicUrl: string, name = 'Unified-App-Infra'): RelyingParty {
  const url = new URL(publicUrl);
  return { id: url.hostname, name, origin: url.origin };
}

export async function startPasskeyRegistration(
  db: MasterDatabase,
  rp: RelyingParty,
  user: { id: string; email: string; name: string },
): Promise<Awaited<ReturnType<typeof generateRegistrationOptions>>> {
  const existing = await listPasskeys(db, user.id);

  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.name,
    attestationType: 'none',
    // Stops the same authenticator being enrolled twice.
    excludeCredentials: existing
      .filter((factor) => factor.credentialId !== null)
      .map((factor) => ({ id: factor.credentialId as string })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  await storeChallenge(db, user.id, 'register', options.challenge);
  return options;
}

export interface FinishRegistrationInput {
  userId: string;
  response: RegistrationResponseJSON;
  label?: string;
}

export async function finishPasskeyRegistration(
  db: MasterDatabase,
  rp: RelyingParty,
  input: FinishRegistrationInput,
): Promise<{ credentialId: string }> {
  const expectedChallenge = await consumeChallenge(db, input.userId, 'register');

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: false,
  });

  if (!verification.verified || verification.registrationInfo === undefined) {
    throw new InfraError('UNAUTHENTICATED', 'passkey registration could not be verified');
  }

  const credential = verification.registrationInfo.credential;
  await savePasskey(db, input.userId, {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: [...(input.response.response.transports ?? [])],
    label: input.label ?? 'Passkey',
  });

  return { credentialId: credential.id };
}

export async function startPasskeyAuthentication(
  db: MasterDatabase,
  rp: RelyingParty,
  userId: string,
): Promise<Awaited<ReturnType<typeof generateAuthenticationOptions>>> {
  const passkeys = await listPasskeys(db, userId);
  if (passkeys.length === 0) throw new InfraError('UNAUTHENTICATED', 'no passkey enrolled');

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: 'preferred',
    allowCredentials: passkeys
      .filter((factor) => factor.credentialId !== null)
      .map((factor) => ({ id: factor.credentialId as string })),
  });

  await storeChallenge(db, userId, 'authenticate', options.challenge);
  return options;
}

export interface FinishAuthenticationInput {
  userId: string;
  response: AuthenticationResponseJSON;
}

export async function finishPasskeyAuthentication(
  db: MasterDatabase,
  rp: RelyingParty,
  input: FinishAuthenticationInput,
): Promise<{ factorId: string }> {
  const expectedChallenge = await consumeChallenge(db, input.userId, 'authenticate');

  const factor = await findPasskeyByCredentialId(db, input.response.id);
  if (factor === null || factor.userId !== input.userId || factor.publicKey === null) {
    throw new InfraError('UNAUTHENTICATED', 'passkey not recognised');
  }

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: false,
    credential: {
      id: factor.credentialId as string,
      publicKey: new Uint8Array(Buffer.from(factor.publicKey, 'base64url')),
      counter: factor.signCount ?? 0,
      transports: (factor.transports ?? []) as never,
    },
  });

  if (!verification.verified) throw new InfraError('UNAUTHENTICATED', 'passkey signature did not verify');

  await updatePasskeyCounter(
    db,
    factor.id,
    verification.authenticationInfo.newCounter,
    factor.signCount ?? 0,
  );

  return { factorId: factor.id };
}
