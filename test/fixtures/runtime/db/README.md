# Schema-1 database fixture

`v1.sqlite` was written by the schema-1 store at commit `af5df8d` running
`mixedWorkload` from `test/support/store-flows.ts` (file store, then WAL checkpoint and
`journal_mode = DELETE`). `v1.sha256` pins its digest. Do not regenerate it with newer code:
it exists to prove that migration 002 keeps a real schema-1 log intact.
