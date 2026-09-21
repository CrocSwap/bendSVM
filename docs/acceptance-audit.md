# Shared application milestone — final acceptance

Audited on 2026-09-20 against the original requirements in
[implementation-plan.md](implementation-plan.md). The implemented, documented
subset supports a vault, vesting contract and fixed-price exchange through the
same compiler and SDK, without application-specific compiler/runtime branches.
The milestone is complete within the [published subset](subset.md).

## Requirement-by-requirement evidence

| Requirement | Current authoritative evidence | Result |
| --- | --- | --- |
| Shared compiler, arithmetic, data/control flow and explicit rejections | `compiler/backend.ts`, `compiler/primitives.ts`, `sdk/math.bend`, `sdk/wide.bend`; all three public application builds; 11 negative proof/backend checks; documented supported forms and resource bounds | Pass |
| Business logic in Bend, no application-specific compiler/SDK changes | `examples/{vault,vesting,exchange}/*.bend` compiled through the same `Backend`, generated storage/effect adapters and `scripts/program.ts`; inspected compiler/SDK/runtime and searched for application-name branches with no matches | Pass |
| Generated dispatch, storage and clients | Checked schemas, C/TypeScript canonical codecs, storage clients and generated interfaces; 299 native interface cases and 288 SBF cases; signed initialization and malformed data tests | Pass |
| Authorization, clock and token custody | Runtime actor/signature/slot construction in shared adapters; stored-owner/beneficiary/maker checks in Bend; shared PDA derivation, expected mint/recipient validation and original SPL Token CPI; lifecycle/negative tests | Pass |
| Vault lifecycle | `tests/vault_sbf.rs`: real mint/account creation, deposits and partial/full withdrawals, full-u64 boundaries, overflow/underflow, owner/signature/mint/account errors and rollback | Pass |
| Vesting lifecycle and funded entitlement | `tests/vesting_sbf.rs`: atomic funding, runtime-slot claims, rounding, repeated/regressed/completed claims, distinct beneficiary and full-u64 cases; source refinement connects initialization, entitlement and authorized exact payouts | Pass |
| Fixed-price exchange lifecycle | `tests/exchange_sbf.rs`: funding, partial/full fills, per-fill ceiling price, maximum-payment limits, cancellation, terminal closure, full-width pricing and atomic two-token settlement | Pass |
| Meaningful laws and negative verification | Bend application laws with 4/4/5 source mutations for vault/vesting/exchange; SDK laws/mutations; eight source-refinement commands check arithmetic and complete source transitions with negative cases and documented replay/witness distinctions | Pass |
| Differential and adversarial coverage | `npm test`: 2,928 arithmetic cases, 410 wide cases, 70 entitlement cases, 72 pricing cases through independent oracle/Bend/native/SBF paths; native ASan/UBSan; 323 application validation transactions (91 vault, 91 vesting, 141 exchange) | Pass |
| Composition across applications | Exchange purchase → vault deposit; vault withdrawal → vesting funding; completion claim; failed later instruction rolls back preceding purchase, checked in `exchange_sbf.rs` | Pass |
| Multiple application state accounts | ABI-2 public layout, per-field schema headers, client codec and all two-to-four-state SBF fixtures; distinct-type rotation, every alias pair, slot validation, real token effects and initialization/CPI rollback | Pass |
| General CPI extension | `sdk/cpi.bend`, shared structural lowering/executor; independent SBF callee tests actor/PDA signatures, bounded key/permission/payload checks, two-call preflight/rollback, protected managed state, all supported state counts, and external-account grow/shrink propagation | Pass within documented bounds |
| Reproducible public builds | Test/public ELFs and fresh-output artifacts/manifests match. Final separate-workspace run used fresh `npm ci --offline`, fresh pinned Bend clone and the same installed Anza toolchain; all artifacts and complete manifests match for all three applications | Pass on pinned local toolchain |
| Documentation, commands and measurements | Current README, subset, arithmetic, interface, CPI, application and refinement documentation; standalone `build:program`, `npm test`, `verify:all`; generated per-application metrics and manifests | Pass |

The fixed-price exchange is the planned small-exchange model. An AMM or order
book, full Bend runtime compatibility and public-network deployment were not
requirements of this milestone.

## Final verification run

- `npm test`: passed, including **33 SBF tests**, source proof mutations, native
  differential/sanitizer checks, all 323 application validation transactions,
  multi-state/CPI fixtures and public build reproduction.
- `npm run verify:all`: passed all **eight** source-refinement commands. Each
  command enforces its positive obligations and negative checks. Unknown/timeouts
  do not pass. See [refinement.md](refinement.md) for precise proof scope.
- `cargo fmt --all -- --check`: passed.
- Separate-workspace production builds: all three application artifacts and
  complete manifests matched byte-for-byte. This is not a second full Rust/native
  test environment or a claim of reproducibility across different hosts/toolchains.
- Current source/artifact hashes were compared with the final manifests; every
  source hash recorded in the eight refinement reports was checked against the
  current worktree. No application source or compiler/runtime code changed afterward.

Final sampled application measurements:

| Application | ELF size | Maximum CU observed in lifecycle fixture, including creation |
| --- | ---: | ---: |
| Vault | 16,840 bytes | 23,206 |
| Vesting | 28,816 bytes | 29,434 |
| Exchange | 30,688 bytes | 49,277 |

CU varies with inputs and PDA derivation. These are observed fixture costs, not
proved worst-case budgets or a comparison with optimized Rust implementations.

Generated evidence lives in `build/`: `final-test.log`, `final-refinement.log`,
`final-clean-build.log`, `refinement-suite.json`, `acceptance-evidence.json`,
`clean-reproducibility.json`, application manifests/metrics/validation reports,
and the per-proof and multi-state/CPI reports. These files are ignored build
artifacts; the checked-in commands and tests reproduce the evidence.

## Assurance boundary and future work

The ordinary Bend checker verifies the stated source laws. The separate SMT
path establishes arithmetic and application transition properties relative to
modeled primitives, with a trusted exporter, solver and compositional proof
driver. Those are not Bend proof terms or an end-to-end correctness proof for
the checker, generated C, LLVM, loader, account adapter or external programs.
SBF/native tests and reproducible builds supply separate evidence for those layers.

The completed subset remains deliberately bounded: nonrecursive first-order
runtime code, concrete data types, fixed-size wire values, at most four managed
state accounts, two effects, and bounded CPI payload/account lists. CPI return
values do not feed back into the same pure transition. Managed state cannot be
forwarded writable; callees see its pre-transition contents when passed read-only.

Broader language/runtime support, richer account lifecycle helpers, Token-2022,
larger/dynamic interfaces, performance comparison with Rust, independent security
review and stronger compiler/checker assurance are future work. They do not
change the completed objective: three distinct, documented applications already
share one compiler and SDK without application-specific compilation changes.
