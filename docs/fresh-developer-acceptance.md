# Fresh-developer workflow acceptance

The automated workflow now changes a starter application's business rule, checks
its new law and proof, executes it in LiteSVM, and runs the same test on a fresh
local validator. This validates the documented developer path; it is not an
independent developer trial or a fresh-machine reproduction.

## Reproduce

After the [external-alpha setup](external-alpha.md):

```sh
npm run doctor
npm run acceptance:developer
```

Start a validator in another terminal using [local-testing.md](local-testing.md),
then run:

```sh
npm run acceptance:developer:local
```

Stop that validator when finished. The commands use a staged source copy,
explicitly recorded dependency/tool caches, fresh application outputs, and fresh
local test keys. No configured wallet or public-network deployment is used.

The [tutorial](external-alpha-tutorial.md) explains the actual source, law, proof
and test edits. Zero-valued appends reject with application code 4; nonzero
appends still succeed, and replacing an existing record with zero remains valid.
The new law covers the application transition after authorization and collection
selection; earlier checks can reject with their own codes.

## Recorded execution

The 2026-09-22 macOS arm64 run used Bun 1.4.2, Rust 1.92.0, Anza platform-tools
v1.53 and Solana CLI/validator 3.0.15. Both LiteSVM and the fresh local validator
passed **7 successful transactions, 4 expected rejections and 22 assertions**.

- Both `verify` and `build` rejected the deliberate code-4-to-code-5 violation
  of the new law with the expected semantic diagnostic. The gate restored the
  source and repeated the successful lifecycle.
- The stale-success prerequisite probe passed. Separate coordinator tests reject
  missing or incomplete offline evidence, changed source, inconsistent byte-match
  evidence and differing deployed bytes.
- The local run downloaded and matched all **12,816 ELF bytes**, with no padding.
  The offline and deployed artifact SHA-256 was
  `f49a704dd7cd30659ffe2a557f035dd68dd7d8de9fe0f9093b900eba4108f471`.
- Thirteen confirmed signatures cover funding, deployment and the eleven test
  transactions. Rejected transactions check unchanged application accounts;
  transaction fees are excluded. The validator was stopped after validation.

The safe top-level reports are:

- `build/fresh-developer-acceptance/acceptance.json`: source inventory, project
  changes, proof failures, offline execution, artifact hashes and cache provenance.
- `build/fresh-developer-acceptance/local-acceptance.json`: hashes linking that
  offline result to the local test report, receipts and downloaded ELF.

The reports retain exact staged paths, source revision, tool versions and command
logs. The local report also binds the test/config/client and runner inputs. The
coordinator checks the offline hashes before and after local execution and
independently compares the downloaded executable bytes. Old aggregate success
reports are removed before each attempt; failed runs retain diagnostic evidence.

Local run directories contain private test keys and stay under ignored `build/`.
Do not publish those directories. CI uploads only explicitly selected safe reports
and artifacts, never staged directories or key files.

## Limits

The checked-in Ubuntu CI workflow runs the offline developer gate and lightweight
local-command failure tests; the localhost deployment requires a running validator.
The execution recorded here was on macOS, and no GitHub/Linux run is claimed.

This milestone supplies a reusable local test/deployment transport. Browser wallet
integration, general public RPC transport, independent developer trials and
production hardening remain separate work. Source laws, runtime tests and byte
equality provide different evidence; none proves the compiler or an arbitrary
deployed application correct.
