/**
 * Session-token provisioning for the control service.
 *
 * The desktop shell hands the token to the node sidecar through a 0600 file
 * (`AGENT_TEAM_SESSION_TOKEN_FILE`) instead of an environment variable so the
 * secret does not appear in `ps eww` output or leak through environment
 * inheritance. The direct `AGENT_TEAM_SESSION_TOKEN` variable remains
 * supported for CLI `serve`, tests, and other embedders; the file takes
 * precedence when both are set.
 */
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export const SESSION_TOKEN_ENV = "AGENT_TEAM_SESSION_TOKEN";
export const SESSION_TOKEN_FILE_ENV = "AGENT_TEAM_SESSION_TOKEN_FILE";

export async function resolveSessionToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const tokenFile = env[SESSION_TOKEN_FILE_ENV];
  if (tokenFile !== undefined && tokenFile !== "") {
    return readSessionTokenFile(tokenFile);
  }
  return env[SESSION_TOKEN_ENV] ?? randomBytes(32).toString("hex");
}

async function readSessionTokenFile(filePath: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read session token file '${filePath}': ${detail}`);
  }
  const token = contents.trim();
  if (token === "") {
    throw new Error(`Session token file '${filePath}' is empty`);
  }
  await assertTokenFilePermissions(filePath);
  return token;
}

/**
 * Best-effort 0600 check. POSIX mode bits are not meaningful on Windows, so
 * the check is skipped there rather than emulated.
 */
async function assertTokenFilePermissions(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  let mode: number;
  try {
    mode = (await stat(filePath)).mode & 0o777;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot inspect session token file '${filePath}': ${detail}`);
  }
  if (mode !== 0o600) {
    throw new Error(
      `Session token file '${filePath}' must have mode 0600 (found ${mode.toString(8).padStart(4, "0")}); refusing to start`,
    );
  }
}
