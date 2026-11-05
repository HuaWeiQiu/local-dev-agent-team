/**
 * A patch that may shadow a base field with `undefined`.
 *
 * `Partial<T>` cannot say this. Under `exactOptionalPropertyTypes` a `Partial` property
 * is "absent, or present with a real value" — writing `undefined` is exactly what the
 * option forbids, because for a plain contract it is the bug the option exists to catch.
 *
 * But a helper whose body is `{ ...base, ...patch }` has a different contract: the patch
 * is applied over a base, so `{ usage: undefined }` means "this run has no usage", and
 * omitting the key would leave the base's value in place. The runtime semantics were
 * always this; only the declaration was narrower than the body it describes.
 *
 * So the choice is made per site, by asking what the site means:
 *
 *   { x?: string }              — a new object handed to an optional contract: omit the key.
 *   { [K in keyof T]?: T[K] | undefined }  — a patch over a base: keep `undefined`, widen here.
 *
 * The error message is identical for both, which is why it cannot be used to decide.
 */
export type Overrides<T> = { [K in keyof T]?: T[K] | undefined };
