import "server-only";
import { config, WORKSPACE_ID } from "../config";
import { verifyPayload } from "../crypto";
import type { Db } from "../db/client";

export async function resolveUnsubscribeToken(db: Db, token: string): Promise<{ id: string; email: string; status: string } | null> {
  const secret = config.auth().value?.secret;
  if (!secret || token.length > 400) return null;
  const p = verifyPayload<{ s: string; w: string }>(token, secret);
  if (!p || p.w !== WORKSPACE_ID) return null;
  const [r] = await db.query<{ id: string; email: string; status: string }>(`select id, email, status from subscribers where id = $1 and workspace_id = $2`, [p.s, WORKSPACE_ID]);
  return r ?? null;
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}
