import { z } from "zod";

export const workflowRoles = [
  "orchestrator",
  "architect",
  "worker",
  "reviewer",
  "tester",
] as const;

export const reasoningSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const permissionSchema = z.enum(["read-only", "workspace-write"]);

export const commandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export const profileSchema = z.object({
  adapter: z.string().min(1),
  executable: z.string().min(1).optional(),
  model: z.string().min(1),
  reasoning: reasoningSchema,
  permission: permissionSchema,
  nativeProfile: z.string().min(1).optional(),
  timeoutSeconds: z.number().int().positive(),
  args: z.array(z.string()).default([]),
});

export const roleSchema = z.object({
  defaultProfile: z.string().min(1),
  allowedProfiles: z.array(z.string().min(1)).min(1),
  fallbackProfiles: z.array(z.string().min(1)).default([]),
  promptFile: z.string().min(1).optional(),
});

export const configSchema = z
  .object({
    version: z.literal(1),
    project: z.object({
      name: z.string().min(1),
      defaultBranch: z.string().min(1),
      stateDirectory: z.string().min(1),
      maxParallel: z.number().int().min(1).max(32),
    }),
    profiles: z.record(z.string().min(1), profileSchema),
    roles: z.record(z.string().min(1), roleSchema),
    quality: z.object({
      commands: z.array(commandSchema),
      maxReworkAttempts: z.number().int().min(0).max(10),
      commandTimeoutSeconds: z.number().int().positive(),
    }),
    github: z.object({
      enabled: z.boolean(),
      remote: z.string().min(1),
      draftPullRequest: z.boolean(),
      autoMerge: z.literal(false),
    }),
  })
  .superRefine((config, context) => {
    if (Object.keys(config.profiles).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["profiles"],
        message: "At least one profile is required",
      });
    }

    for (const roleName of workflowRoles) {
      if (!config.roles[roleName]) {
        context.addIssue({
          code: "custom",
          path: ["roles", roleName],
          message: `Required workflow role '${roleName}' is missing`,
        });
      }
    }

    for (const [roleName, role] of Object.entries(config.roles)) {
      const referenced = [
        role.defaultProfile,
        ...role.allowedProfiles,
        ...role.fallbackProfiles,
      ];
      for (const profileName of referenced) {
        if (!config.profiles[profileName]) {
          context.addIssue({
            code: "custom",
            path: ["roles", roleName],
            message: `Role references unknown profile '${profileName}'`,
          });
        }
      }
      if (!role.allowedProfiles.includes(role.defaultProfile)) {
        context.addIssue({
          code: "custom",
          path: ["roles", roleName, "allowedProfiles"],
          message: "The default profile must also be allowed",
        });
      }
    }

    for (const roleName of ["orchestrator", "architect", "reviewer"] as const) {
      const role = config.roles[roleName];
      const profile = role ? config.profiles[role.defaultProfile] : undefined;
      if (profile?.permission === "workspace-write") {
        context.addIssue({
          code: "custom",
          path: ["roles", roleName, "defaultProfile"],
          message: `${roleName} must use a read-only default profile`,
        });
      }
    }
  });

export type AgentTeamConfig = z.infer<typeof configSchema>;
export type AgentProfile = z.infer<typeof profileSchema>;
export type RolePolicy = z.infer<typeof roleSchema>;
export type Reasoning = z.infer<typeof reasoningSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type CommandSpec = z.infer<typeof commandSchema>;
