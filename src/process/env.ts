/**
 * Environment hygiene for child processes.
 *
 * The orchestrator process carries secrets in `AGENT_TEAM_*` variables (most
 * notably `AGENT_TEAM_SESSION_TOKEN`, which authorizes approval and publish
 * calls against the control service). Semi-trusted agent CLIs and quality
 * commands must never inherit them, and if a secret is printed by a child it
 * must not reach persisted logs or the event stream.
 */

const AGENT_TEAM_ENV_PREFIX = "AGENT_TEAM_";
const REDACTED = "[redacted]";
/** Shorter values are too likely to appear in benign output to be redacted safely. */
const MIN_REDACTED_SECRET_LENGTH = 8;

/**
 * Copy of `base` with every `AGENT_TEAM_*` variable removed.
 * This is a denylist, not a whitelist: PATH, HOME, proxy, and CLI-specific
 * variables pass through unchanged so agent CLIs keep working.
 */
export function sanitizedChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith(AGENT_TEAM_ENV_PREFIX)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Values of `AGENT_TEAM_*` variables that must not leak into captured output.
 * Longest first so overlapping values redact deterministically.
 */
export function envSecretValues(base: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith(AGENT_TEAM_ENV_PREFIX) || value === undefined) {
      continue;
    }
    if (value.length < MIN_REDACTED_SECRET_LENGTH) {
      continue;
    }
    values.push(value);
  }
  return values.sort((a, b) => b.length - a.length);
}

/** Replace every exact occurrence of the given secret values with `[redacted]`. */
export function redactEnvSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && result.includes(secret)) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}
