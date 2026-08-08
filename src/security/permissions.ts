export function assertRoleProfilePermission(
  role: string,
  profileName: string,
  permission: string,
): void {
  if (role !== "worker" && permission === "workspace-write") {
    throw new Error(
      `Role '${role}' cannot use workspace-write profile '${profileName}'`,
    );
  }
}

export function assertDiagnosticProfilePermission(
  role: string,
  profileName: string,
  permission: string,
): void {
  if (permission === "workspace-write") {
    throw new Error(
      `Diagnostic invocation for role '${role}' cannot use workspace-write profile '${profileName}'`,
    );
  }
}
