import "server-only";
import { config, WORKSPACE_ID } from "../config";
import { decrypt, encrypt } from "../crypto";
import { iso, json, type Db } from "../db/client";
import { GoogleApiError, refreshAccessToken, SCOPES, type GoogleFeature, type TokenSet } from "../providers/google";
import { markHealth } from "../repo/ops";

// Google tokens live encrypted (AES-256-GCM, TOKEN_ENCRYPTION_KEY) in
// integration_credentials — never in settings, logs or the client.

export interface GoogleConnection {
  accountEmail: string | null;
  scopes: string[];
  status: "READY" | "NEEDS_ATTENTION";
  lastError: string | null;
  updatedAt: string | null;
}

export function hasFeature(conn: GoogleConnection | null, feature: GoogleFeature): boolean {
  return !!conn && conn.status === "READY" && SCOPES[feature].every((s) => conn.scopes.includes(s));
}

export async function getGoogleConnection(db: Db): Promise<GoogleConnection | null> {
  const [r] = await db.query<Record<string, unknown>>(`select * from integration_credentials where workspace_id = $1 and provider = 'google'`, [WORKSPACE_ID]);
  if (!r) return null;
  return {
    accountEmail: (r.account_email as string) ?? null,
    scopes: (r.scopes as string[]) ?? [],
    status: r.status as GoogleConnection["status"],
    lastError: (r.last_error as string) ?? null,
    updatedAt: iso(r.updated_at),
  };
}

export async function storeTokens(db: Db, tokens: TokenSet, accountEmail: string | null) {
  const key = config.tokenKey().value!.key;
  const [existing] = await db.query<Record<string, unknown>>(`select encrypted, scopes from integration_credentials where workspace_id = $1 and provider = 'google'`, [WORKSPACE_ID]);
  let refreshToken = tokens.refreshToken;
  if (!refreshToken && existing) {
    try {
      refreshToken = (JSON.parse(decrypt(String(existing.encrypted), key)) as TokenSet).refreshToken;
    } catch {
      refreshToken = null;
    }
  }
  const scopes = [...new Set([...(tokens.scopes ?? [])])];
  await db.query(
    `insert into integration_credentials (workspace_id, provider, encrypted, scopes, account_email, status, last_error, updated_at)
     values ($1,'google',$2,$3::jsonb,$4,'READY',null,now())
     on conflict (workspace_id, provider) do update set encrypted = excluded.encrypted, scopes = excluded.scopes,
       account_email = coalesce(excluded.account_email, integration_credentials.account_email), status = 'READY', last_error = null, updated_at = now()`,
    [WORKSPACE_ID, encrypt(JSON.stringify({ ...tokens, refreshToken }), key), json(scopes), accountEmail],
  );
}

async function markNeedsAttention(db: Db, message: string) {
  await db.query(`update integration_credentials set status = 'NEEDS_ATTENTION', last_error = $2, updated_at = now() where workspace_id = $1 and provider = 'google'`, [WORKSPACE_ID, message]);
  await markHealth(db, "google", false, message);
}

// Returns a valid access token for a feature, refreshing when needed.
export async function googleAccessToken(db: Db, feature: GoogleFeature): Promise<{ token: string; email: string | null }> {
  const g = config.google();
  if (!g.ok) throw new GoogleApiError(`Google isn't configured (${g.missing.join(", ")} missing).`, "AUTH");
  const [r] = await db.query<Record<string, unknown>>(`select * from integration_credentials where workspace_id = $1 and provider = 'google'`, [WORKSPACE_ID]);
  if (!r) throw new GoogleApiError("Google account isn't connected.", "AUTH");
  if (r.status === "NEEDS_ATTENTION") throw new GoogleApiError(`Google needs to be reconnected: ${r.last_error ?? "access was revoked"}.`, "REVOKED");
  const scopes = (r.scopes as string[]) ?? [];
  if (!SCOPES[feature].every((s) => scopes.includes(s))) {
    throw new GoogleApiError(`The connected Google account hasn't granted ${feature === "send" ? "sending" : feature === "feedback" ? "mailbox reading" : "calendar"} access. Connect it in Settings.`, "SCOPE");
  }
  const key = config.tokenKey().value!.key;
  let tokens: TokenSet;
  try {
    tokens = JSON.parse(decrypt(String(r.encrypted), key)) as TokenSet;
  } catch {
    await markNeedsAttention(db, "Stored credentials couldn't be decrypted (was TOKEN_ENCRYPTION_KEY changed?)");
    throw new GoogleApiError("Stored Google credentials couldn't be read. Reconnect Google.", "REVOKED");
  }
  if (tokens.expiresAt - Date.now() > 90_000) return { token: tokens.accessToken, email: (r.account_email as string) ?? null };
  if (!tokens.refreshToken) {
    await markNeedsAttention(db, "No refresh token stored");
    throw new GoogleApiError("Google session expired and can't be refreshed. Reconnect Google.", "REVOKED");
  }
  try {
    const fresh = await refreshAccessToken({ clientId: g.value!.clientId, clientSecret: g.value!.clientSecret, refreshToken: tokens.refreshToken });
    const merged: TokenSet = { ...tokens, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
    await db.query(`update integration_credentials set encrypted = $2, updated_at = now() where workspace_id = $1 and provider = 'google'`, [WORKSPACE_ID, encrypt(JSON.stringify(merged), key)]);
    return { token: merged.accessToken, email: (r.account_email as string) ?? null };
  } catch (e) {
    if (e instanceof GoogleApiError && e.kind === "REVOKED") await markNeedsAttention(db, e.message);
    throw e;
  }
}
