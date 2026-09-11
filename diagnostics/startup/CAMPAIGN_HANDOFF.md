# Startup campaign handoff

The user assigned CI verification to another worker. Do not wait for CI in the implementation task. No release or PR for these prototypes has been published. The automatic tiny-program specialization below is a proposal, not an implemented change.

## Exact source

Baseline: `603b074ace01464bc66fc07cc8d532f26ccf5a0f` (0.5.1532).

| Change | Branch in proggeramlug/perry | Exact final source |
|---|---|---|
| Empty event-loop checkpoints and beforeExit re-entry | `perf/startup-overhead` | `ef90b2afc3a5f39eeb91d900a1fc5670f1f9d898` |
| Lazy class-parent storage | `perf/startup-lazy-state` | `8516ab90bae4e5af5ef9d7d2a74ffd020392e87f` |
| Optional Linux small-process policy | `perf/startup-memory-profile` | `55a29934b1f1fd6dd1ce9f47e9f4d9b71286a04c` |
| npm core profile, including Math, native-import and global-object guards | `perf/startup-prebuilt-core` | `4c3753be56c7b17574caeb1f4949bb6e2e3e557f` |
| Combined integration candidate | `perf/startup-release-candidate` | `055281f08f1598fbe9c8071a4efd013ac591856d` |

Benchmark harness: `proggeramlug/js-compiled`, branch `perf/startup-verification`; use `b8371c8` or later. It always separates baseline/candidate Cargo target directories and includes the hot inherited-class throughput witness.

The combined branch applies the independently developed changes on the pinned baseline. All five `prebuilt_core::tests` pass locally at the combined commit in its own `target/startup-isolated` directory; the log is `results/startup-comparison/combined-core-selection-final-tests.log`. `git diff --check` passes. It has not passed the final combined package/platform gate. Do not label S7 complete until that evidence exists.

## Build-isolation finding — important to verification

Do not share a Cargo output directory across the baseline/candidate source trees. A minimal reproduction on nightly-2026-08-20 showed an old build-script C archive surviving while changed Rust code compiled, yielding an undefined policy anchor; before touching the Rust source Cargo even reused the entire baseline crate as `Fresh`. A source/build-id marker and archive hash alone do not exclude that mixture.

The same S4 source built in an isolated target links successfully and passes all three pre-main normal/small/override cases: [production archive job](https://github.com/proggeramlug/js-compiled/actions/runs/34576539273). The earlier independent C probe passed twelve override cases. No allocator-policy source fix was needed for the failed shared-target native build.

Treat prior S2/S3 shared-target CI measurements as provisional. In particular the older runs included apparent Linux 4–5% startup wins, but a later shared-target run emitted the old beforeExit behavior despite the candidate source. Acceptance requires the isolated reruns. S1 unchanged-binary calibration and the original immutable released-npm THP experiments remain valid.

Local details: `results/startup-campaign/build-isolation-finding.md`, `shared-archive-failure-repro.json`, `../s4-archive-ci-34576539273/` (results are local artifacts, not committed binaries).

## Local verification and remaining work

- S2: 47 targeted Rust tests and 22 benchmark oracles passed in development; ordinary beforeExit/exit fixtures and boundary moving-GC probes passed locally. Revalidate the exact source with isolated binaries. The revised boundary harness explicitly disables loop polls for loop-free boundary fixtures while requiring actual copying/moved objects.
- S3a: 20 focused Rust tests passed. Late class registration survives moving GC (12,515 moved objects). Local tiny RSS fell about 240–256 KiB. Isolated platform throughput, including `verify-class-throughput.mjs`, remains a gate.
- S3b: diagnostics initialization and late scanner registration are deferred. Main-thread ownership and active incremental-cycle registry snapshots need separate correctness designs; scanner registration itself does not eagerly allocate every subsystem's object store.
- S4: real isolated archive link and pre-main policy/override checks pass. Full native default/small comparisons must establish the RSS target and document optional throughput tradeoffs on both Intel and AMD Linux with THP metadata. Ordinary policy must remain intact.
- S5: local clean compressed npm staging/install at `2ad26ee04` produces empty/noop/hello binaries 44.6–44.7% smaller (16.42–16.46 MB → 9.08–9.11 MB). Unstripped symbol witnesses remove regex-engine and Temporal symbols. This is a size result, not an accepted time/RSS result. Exceptions, regex, Intl, Temporal, dynamic evaluation, workers and missing-core fallback checks passed. The FFI fixture exposed that runtime-owned imports do not enter the stdlib marker set. Follow-up `981ee28e8` inspects HIR native-import provenance, with a regression test including erased/type-only imports. A second actual counterexample, `globalThis[process.argv[2]]` with `RegExp` supplied at runtime, failed with the old core archive while Node/full Perry passed. Final source `4c3753be5` conservatively keeps full runtime for global-object access, including aliases and folded `Function("return this")()`; a fifth selection test covers those forms. The package fixtures now execute computed global constructors. Re-run the package gate on this final source: local size measurements predate both guards, and the workflow pin has been updated.
- S6: the unguarded console/static-literal shortcut is rejected for this campaign. Baseline direct calls ignore console replacement and diagnostics can mutate the argument array. A future whole-program proof may safely admit a narrow subset; see the automatic tiny proposal below.
- S7: run the combined candidate through the same correctness, GC, throughput and installed-package gates. The tracker intentionally leaves its checkbox open.

The local 2ad26ee04 22-benchmark run was stopped after the native-import follow-up superseded its source; its partial JSON is explicitly marked incomplete, not a suite pass.

Local receipts are under `results/startup-campaign/`; see `PROGRESS.md`. The authoritative user-facing milestone tracker is `../secret-tests/PERRY_STARTUP_PLAN.md` in the shared workspace.

## CI worker

Submitted isolated runs (statuses deliberately not polled after ownership changed): S2 `34577401644`, S3 `34577401579`, S4 `34577157809`, S5 `34577401653`. That S5 run uses the older `2ad26ee04` pin and lacks both fallback fixes. The current core-package workflow pins `4c3753be5`; use its new push-triggered run or dispatch it. No status of that updated run is claimed here. Older shared-target runs are diagnostic only.

Use the existing workflows and helpers, with exact source pins updated. `build-candidate.py` places Rust test outputs under `cargo-target/candidate`; same-source package A/A reuse uses `cargo-target/baseline`. Build runtime and stdlib in separate Cargo invocations, retain immutable copies, and preserve unwind flags. The core archive uses `scripts/build_core_runtime.sh`; clean npm verification uses `prepare-core-package.py` then `verify-core-package.mjs`.

Final required gates:

1. Five warmups, A/A calibration, two alternating 100-pair A/B batches, five RSS samples for empty/noop/hello with scriptc and spawn controls; actual archive/compiler hashes and raw samples.
2. All 22 Node oracles; five throughput sentinels, extending >3% slowdowns to ten samples; hot class throughput; focused runtime/codegen/profile tests.
3. Event-loop/lifecycle and late-class moving-GC fixtures, including first use after prior collection. Require actual collections and moved objects.
4. Clean installed npm layout without source discovery, core/full selection, symbols, optional engines/native imports and missing archive fallback. For the combined before/after comparison, use the baseline 603b compiler/full archive versus the installed combined compiler with automatic selection, not just combined-full versus combined-core.
5. Linux x64 and macOS ARM64; allocator tradeoffs on Intel and AMD Linux. Final release acceptance must use the intended distribution packaging settings and record them; `dist` is defined to mirror release but the exact commands still belong in the receipt.

## Next proposed optimization

[Automatic tiny-program specialization](STRICT_TINY_PROPOSAL.md): the compiler decides automatically, with no user flag. Only a strict proof of no asynchronous/lifecycle work and no managed allocations selects the minimal entry/printing path; all unproven programs compile through the normal runtime. Begin with literal/constant-string output and expand only with evidence. The proposal has separate eligibility, codegen, semantic and package/performance steps. It is not included in the current integration branch.
