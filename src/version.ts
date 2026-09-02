/** Product version shared by CLI, control service, and desktop shell. */
export const APP_VERSION = "0.1.0";

/**
 * Control-plane / web build stamp. Bump when shipping a desktop-visible
 * experience change so the shell can tell an old frontend from a new one.
 */
export const CONTROL_PLANE_BUILD = "2026.08.17-github-changes";

/** New experience APIs refuse clients older than this build stamp. */
export const MIN_CLIENT_BUILD = CONTROL_PLANE_BUILD;

const gatedPathPattern =
  /\/(git\/(status|diff|stash|init|initial-commit|changes|connect|commit|push)|branches|inquiries|publish-preview)(\/|$)/;

export function clientBuildTooOld(clientBuild: string | undefined, path: string): boolean {
  if (!gatedPathPattern.test(path)) return false;
  if (!clientBuild) return false;
  return clientBuild !== MIN_CLIENT_BUILD;
}

export interface ControlPlaneIdentity {
  version: string;
  build: string;
}

export function controlPlaneIdentity(): ControlPlaneIdentity {
  return { version: APP_VERSION, build: CONTROL_PLANE_BUILD };
}
