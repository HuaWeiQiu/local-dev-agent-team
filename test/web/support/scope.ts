import type { ProjectScope } from "../../../web/src/types.js";

/**
 * The project selection every web test scopes its requests by.
 *
 * One definition on purpose. This literal had been copied into fourteen files,
 * and the copies drifted: six were typed, five cast to `never`, two described the
 * project *record* (`{id, name, root}`) instead of the selection (`{mode,
 * projectId}`) — shapes with no field in common. The cast hid the difference, so
 * the compiler reported "missing properties" rather than "you are describing a
 * different object".
 *
 * A test that genuinely needs a different scope passes it here, e.g.
 * `projectScope({ mode: "workspace" })`. The difference then lives at the call
 * site where a reader can see it, instead of in a local copy that drifts — "I am
 * a bit different" is how the fourteenth copy starts.
 */
export function projectScope(overrides: Partial<ProjectScope> = {}): ProjectScope {
  return { mode: "single", projectId: "p1", ...overrides };
}
