import { z } from "zod";

export const workspaceProjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  config: z.string().min(1),
});

export const workspaceSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(workspaceProjectSchema).min(1).max(64),
  })
  .superRefine((workspace, context) => {
    const ids = new Set<string>();
    workspace.projects.forEach((project, index) => {
      if (ids.has(project.id)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "id"],
          message: `Duplicate project ID '${project.id}'`,
        });
      }
      ids.add(project.id);
    });
  });

export type AgentTeamWorkspace = z.infer<typeof workspaceSchema>;
