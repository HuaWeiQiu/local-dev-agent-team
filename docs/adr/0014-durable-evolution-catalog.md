# ADR 0014: Durable Evolution Catalog

- Status: Accepted
- Date: 2026-08-11

## Context

Phase 1 delivered a pure domain module and an authoritative in-memory
`EvolutionCatalog` (see [ADR 0013](./0013-bounded-evolution-domain-catalog-boundary.md)).
Process restarts discarded every proposal, audit record, active pointer, and
promotion provenance.

Phase 2 must add **trusted, repository-local durability** without changing
Phase 1 lifecycle semantics, without applying prompt/strategy files, and
without introducing HTTP, UI, agent execution, suggestions, automatic
evaluation, or automatic promotion.

## Decision

### Ownership split

| Layer | Path | Responsibility |
| --- | --- | --- |
| Domain | `src/evolution/domain.ts` | Unchanged pure schemas, trust checks, digests, guarded lifecycle |
| Catalog | `src/evolution/catalog.ts` | Pure, synchronous in-memory authority; trust-validating restore that independently replays audit and provenance |
| Persistence | `src/evolution/persistence.ts` | Asynchronous `DurableEvolutionCatalog` wrapper: open, queue, atomic disk commit, fail-closed reopen |

`EvolutionCatalog` remains free of filesystem I/O. All durability lives in the
wrapper.

### Trust boundary

```text
LoadedConfig.roles
  -> createEvolutionTrustContext({ roles })
  -> DurableEvolutionCatalog.open
  -> parse/revalidate every proposal and audit record
  -> EvolutionCatalog (memory)
```

- `EvolutionTrustContext` is derived **only** from `LoadedConfig.config.roles`
  (`promptFile` and `allowedProfiles`). Proposal payloads and policy allowlists
  never establish trust by themselves.
- `stateDirectory` must be a safe, repository-owned relative path under
  `LoadedConfig.root`. Absolute escapes, `..` segments, and paths that resolve
  outside the repository root are rejected. Existing path components and the
  primary file must not be symbolic links; the boundary is rechecked before
  every commit.
- Durable files live under `<root>/<stateDirectory>/evolution/`.

### Document contract

Primary file: `catalog.json` inside the evolution directory.

```text
{
  "version": 1,                 // only supported durable document version
  "revision": <positive uint>,  // exact number of recorded catalog mutations
  "payloadDigest": "<hex>",     // SHA-256 over canonical payload JSON
  "payload": {
    "proposals": [ ... ],
    "auditRecords": [ ... ],    // append order (not snapshot sort order)
    "activeProposals": [ ... ],
    "promotionRecords": [ ... ] // internal rollback provenance
  }
}
```

Rules:

1. **Strict versioning** — unsupported or missing `version` fails closed.
2. **Monotonic revision** — memory starts at `0` only while no primary document
   exists. Each successful mutation persists `revision + 1`; a persisted v1
   revision must be a positive safe integer exactly equal to the proposal count
   plus all recorded lifecycle-transition counts. On mutate, the complete
   on-disk document is revalidated and must match both the last committed
   revision and material, otherwise the write fails closed.
3. **Payload integrity digest** — `payloadDigest` is the lowercase hex
   SHA-256 of the deterministic canonical JSON encoding of `payload`
   (object keys sorted recursively). On open, the digest is recomputed and
   compared.
4. **Digest threat model** — the digest detects accidental corruption and
   naive truncation. It is **not** authentication and does **not** protect
   against an attacker who can write the repository state directory (they can
   rewrite both payload and digest together).
5. **Preservation** — every proposal, the ordered audit history, promotion
   provenance, and active-target pointers required for recovery are stored.

### Atomic commit

Every mutation:

1. runs on a **failure-tolerant promise queue** (a rejected mutation does not
   poison later work);
2. **stages** against a working `EvolutionCatalog` restored from the last
   committed material (the live catalog is not mutated first);
3. writes a unique temporary file with flag `wx` and mode `0600`;
4. `fsync`s the temporary file;
5. `rename`s onto `catalog.json`;
6. `fsync`s the evolution directory;
7. **only then** swaps in-memory catalog and revision to the staged result.

Failures before rename leave memory and the primary file at the last committed
revision and leave the queue usable. If rename completes but directory fsync
fails, durability is indeterminate: memory is not swapped, the instance rejects
all further mutations, and the caller must reopen to reconcile the complete
old-or-new primary document. The implementation never guesses or overwrites
that state.

The pre-write validation detects a document changed since this instance last
committed, but it is not an atomic filesystem compare-and-swap and does not
lock across processes. Two independently opened instances can still pass their
checks concurrently and race at rename. Phase 2 guarantees serialization only
inside one `DurableEvolutionCatalog` instance; deployments must use one writer.

### Restoration validation (fail closed)

Open / reopen re-parses JSON and revalidates with the **current** trust
context. Open fails closed when any of the following hold:

- malformed JSON or non-object document;
- unsupported document version;
- payload digest mismatch;
- forged allowlists or profiles that current roles no longer trust;
- impossible lifecycle history or promotion chain;
- invalid active pointer (missing proposal, non-promoted status, target mismatch);
- duplicate proposal or promotion ids;
- stale / non-monotonic / non-integral revision;
- audit or promotion provenance inconsistent with proposals.

Absence of `catalog.json` yields an empty catalog at revision `0`.

Orphan `catalog.json.*.tmp` files may be ignored or safely deleted. A
**corrupt primary** document must never be treated as an empty catalog.

### Explicit non-goals (still deferred)

- Applying prompt files or strategy definitions to the repository
- HTTP API, UI, agent execution, suggestions
- Automatic evaluation or automatic promotion
- Credentials, network publication, configuration/workflow redesign
- Shell-based agent invocation or source-tree mutation by the catalog

## Consequences

- Operators can restart a process and reopen the same evolution directory under
  the same trusted roles without replaying manual in-memory steps.
- Tightening role allowlists or prompt paths after a durable write correctly
  fails reopen until the operator reconciles trust and stored candidates.
- Concurrent mutations on one `DurableEvolutionCatalog` instance are
  serialized; updates are not lost.
- Reviewers can reason about durability independently of Phase 1 domain rules.
- Later phases may apply files or expose APIs without rewriting the durable
  document contract, provided they keep domain pure and trust config-derived.

## References

- Implementation: `src/evolution/persistence.ts`, `src/evolution/catalog.ts`
- Domain: `src/evolution/domain.ts`
- Tests: `test/evolution-persistence.test.ts`
- Phase guide: [docs/evolution-phase-1.zh-CN.md](../evolution-phase-1.zh-CN.md)
- Prior boundary: [ADR 0013](./0013-bounded-evolution-domain-catalog-boundary.md)
