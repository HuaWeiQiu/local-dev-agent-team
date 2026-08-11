import { createHash } from "node:crypto";

export const E2E_SESSION_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function e2eSessionCookieName(): string {
  return `agent_team_session_${createHash("sha256").update(E2E_SESSION_TOKEN).digest("hex").slice(0, 16)}`;
}
