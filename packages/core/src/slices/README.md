# slices

One folder per capability, with its use cases, schemas and colocated tests. Public surface is the slice's `index.ts`.
Slices do not import each other; only `workflow-engine` composes slices.
See `docs/spec/architecture.md`, section 5.
