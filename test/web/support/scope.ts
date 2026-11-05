import type { ProjectScope } from "../../../web/src/types.js";

/**
 * The project selection every web test scopes its requests by.
 *
 * One definition on purpose. This literal had been copied into fourteen files,
 * and the copies drifted: six were typed, five cast to `never`, and two described
 * the project *record* (`{id, name, root}`) instead of the selection
 * (`{mode, projectId}`) — shapes with no field in common. The cast hid the
 * difference, so the compiler reported "missing properties" rather than "you are
 * describing a different object".
 */
export const projectScope: ProjectScope = { mode: "single", projectId: "p1" };
