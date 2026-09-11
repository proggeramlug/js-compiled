# Perry startup campaign — local verification, 2026-09-11

PR: [PerryTS/perry#10066](https://github.com/PerryTS/perry/pull/10066). Local matrix: AMD Ryzen 7 7700X Linux x64 and Apple M1 Max macOS ARM64. Intel allocator coverage is deferred at the user’s request because no host is available. CI and official release validation remain owned by another worker; neither is awaited or represented as complete here.

## Result

The compiler automatically recognizes a deliberately small set of programs that need no managed allocation or JS scheduling. Empty programs and proven constant-string `console.log` / `console.error` programs link a tiny entry and native output helper instead of the Perry runtime. No enabling flag is added. Programs outside the proof retain normal compilation.

| Input | AMD baseline → tiny median, ms | AMD peak RSS, KiB | Mac baseline → tiny median, ms | Mac peak RSS, KiB |
|---|---|---|---|---|
| Empty | 2.458 / 2.477 → 0.950 / 1.010 | 18,696 → 1,308 | 3.907 / 3.856 → 2.246 / 2.096 | 5,200 → 1,360 |
| Noop | 2.608 / 2.632 → 1.024 / 1.008 | 21,636 → 1,308 | 3.950 / 3.897 → 2.210 / 2.189 | 5,872 → 1,344 |
| Hello | 2.658 / 2.661 → 1.014 / 1.010 | 21,572 → 1,308 | 4.021 / 3.973 → 2.269 / 2.242 | 5,872 → 1,360 |

The two timings are separate A/B batches. All three cases meet the repeatable-win criterion on both machines after accounting for unchanged-binary A/A noise. Same-host scriptc hello is about 0.983 ms on Linux and 2.25 ms on Mac. This brings Perry close to scriptc for the proven subset; it does not promise the same startup numbers on other machines or applications. The previously reported 18 MB / 4.2 ms CI result is a different environment.

Tiny binaries are 14,256 bytes for Linux empty and 14,472 bytes for Linux noop/hello; Mac sizes are 16,824 and 33,848 bytes. Linked-symbol and generated-IR checks exclude Perry GC initialization, managed allocation, roots, class tables, promises, mimalloc and JS event-loop machinery. The operating system and C library remain dependencies; the process is not described as using literally no memory.

## What was accepted or rejected

| Milestone | Decision | Evidence |
|---|---|---|
| S1 measurement harness | Accepted | Immutable receipts, A/A calibration, two 100-pair A/B batches, five warmups and five RSS samples. |
| S2 empty checkpoints | Accepted | Six empty drains avoid timer setup while keeping required GC/native/lifecycle boundaries. Repeated beforeExit after newly scheduled work is fixed. |
| S3 lazy state | Class-parent table accepted; diagnostics/scanners deferred | First/late registration, concurrency, moving GC and hot inherited-class throughput. Ownership and active-cycle scanner semantics need separate designs. |
| S4 optional allocator policy | Accepted on AMD; Intel deferred | `PERRY_MEMORY_PROFILE=small` applies before allocation and respects explicit mimalloc overrides. It remains an explicit choice for normal-runtime applications. |
| S5 packaged core archive | Accepted | Clean compressed npm installation, conservative core/full selection, engine/native import/global-access and missing-core fallbacks. |
| S6 general console shortcut | Rejected | The baseline’s replacement behavior and observable diagnostics require a proper callee/observer guard; an unguarded general shortcut is unsafe. |
| T1–T4 strict tiny specialization | Accepted | Original-AST proof, audited helper, positive/fallback/oracle tests and installed-package measurements. |
| S7 combined local verification | Local gates passed for the agreed AMD/Mac matrix | See exact-source verification and retained throughput evidence below. |

Packed ELF relocations are also deferred: the experiment reduced file size without establishing a startup benefit. Closed/rejected ideas are not marked as implemented.

The ordinary full runtime comparison mostly has inconclusive startup timing, apart from Linux empty. It saves approximately 4 MiB RSS on Linux and 0.8 MiB on Mac in this combined comparison. These measurements do not isolate each runtime change’s individual contribution. Core-only unstripped symbol witnesses shrink from 24,602,344 to 14,792,088 bytes on Linux and 19,069,656 to 10,917,352 bytes on Mac. Those are size results, distinct from the stripped tiny startup results above.

The optional Linux small-memory policy reduces ordinary-runtime peak RSS from 14,628 to 8,908 KiB (empty), 17,348 to 9,776 KiB (noop), and 17,484 to 9,824 KiB (hello): 39–44%. Kernel THP mode is `madvise`. Throughput ratios candidate/baseline are 0.996 for loop sum, 1.082 for binary trees, 1.023 for map/set, 1.107 for JSON and 1.063 for async. These documented costs are accepted only for the explicit profile; normal allocator defaults remain unchanged. Tiny programs omit mimalloc, so the profile has no allocator to configure there.

## Exact-source verification

Baseline: `603b074ace01464bc66fc07cc8d532f26ccf5a0f`. Measured implementation: `27c598181dfb331d72a798754641082584028df0`. Final compiled source: `2c08ccfce1a96bfbd825bdedbd591cf47fd88883`. PR head `ef9e56e4ef17a9669bd78b96b4ef2cf0c0ac3057` only renames the five changelog fragments for PR #10066 and links this report; every file outside `changelog.d` is identical to the compiled source ([receipt](final-source-receipt.json)). The follow-up changes compiler text/JSON reporting after linking, fixes a glibc fault-injection test issue, and clarifies documentation. Runtime, codegen, tiny analysis/emission and the native output helper remain unchanged.

Matching final compiler, full runtime, stdlib and core archives were rebuilt separately on both hosts. Complete ELF/Mach-O comparison proves the three installed tiny images, all 22 ordinary workload images and all 22 installed automatic workload images and the hot-class witness unchanged after normalizing only source-ID/build-ID/UUID/code-signature metadata. Code, data, addresses, sizes, relocations and loader commands must match. A deliberate output-data mutation was rejected by the checker. These receipts justify carrying the measured implementation’s performance results forward; this is stronger than assuming that a reporting-only edit cannot affect output.

Each platform has:

- 57 focused runtime/codegen tests at the measured implementation and 17 compiler tests, with the 17 repeated on the final compiler. The unchanged runtime/codegen source and image receipts preserve the earlier tests’ scope.
- Clippy checks for the product and changed runtime/codegen crates at the measured implementation; existing warnings are not represented as zero warnings.
- All 22 benchmark Node oracles, repeated with the final compiler; 20 lifecycle/class fixtures, two exit-code probes and three actual moving-GC witnesses. A known baseline beforeExit defect is recorded only for the baseline; the candidate must match Node.
- A real compressed npm stage/pack/install outside source discovery, with ten core/full feature fixtures, a missing-core fallback, 15 accepted tiny and 13 normal-fallback executable fixtures, and a final JSON result-envelope comparison with ordinary compilation.
- Output checks for stdout/stderr handshakes, Unicode, NUL, percent signs, empty strings, surrogate pairs across substitutions, broken/closed pipes and native fault injection for partial writes, EINTR, EAGAIN and interrupted poll.
- Installed automatic-package throughput guards and hot inherited-class checks. The latter ratios are 1.0049 on Linux and 1.0086 on Mac.

Linux also passes 12 standalone C policy cases, 12 cases linked against the actual release runtime archive, and normal/small/override Rust checks in three fresh processes.

The final default-profile throughput gate on Mac reuses the completed 22-case Node oracle only for unrelated cases, after requiring the identical immutable manifest; all five sentinels execute again and check their output on every sample. Five tampered/incomplete prior-oracle shapes are rejected before timing. The exact guard and sample counts are retained in the result.

The earlier Mac map/set estimate was +7.08% with a paired confidence interval including zero. Twenty additional pairs gave a marginal median ratio of 0.9656, while pooling marginal medians across sharply changing host load gave 1.0521 and **failed** that confirmation’s declared rule. That failed confirmation is retained as a failure. The final-source run, after this task’s compiler/package/oracle work completed, gives a map/set ratio of 0.9928. The original apparent slowdown did not repeat; the final five-sentinel result is recorded separately, not substituted into the old files. Host load remains variable, so apparent ordinary-runtime speedups are not promoted as optimization claims. The accepted startup gains above use their separate repeated A/B and A/A measurements.

Final guard ratios (candidate/baseline; lower is faster):

| Default throughput guard | AMD ratio | Mac final ratio |
|---|---|---|
| 11-loop-sum | 1.0024 | 0.9667 |
| 23-binary-trees | 1.0068 | 0.9290 |
| 24-map-set | 0.9969 | 0.9928 |
| 31-json | 0.9883 | 0.9926 |
| 42-async | 0.9884 | 0.9981 |

The script-only lint mirror passes 75 of 76 gates. The public-benchmark freshness failure also occurs on untouched baseline 603b; both report fingerprint `9507434be47f7bb383c30810bdc5d66d9be65290da529f38b7473860ea98f75e`. The compile tier was explicitly excluded from that script-only result. Full workspace/gap-suite CI is not claimed by these focused local checks.

## Findings that changed the implementation

1. Sharing Cargo output directories across source worktrees can retain stale native C build-script output even when Rust and source identity markers update. Every final source worktree uses its own target directory. Runtime and stdlib archives are built in separate release invocations and copied immutably.
2. A blocking stdout-only helper can deadlock when the reader waits for stderr before draining stdout. The final helper maintains two stack cursors and drains the streams independently. Bounded native polling under pipe/socket backpressure is necessary I/O handling, not a JS event loop.
3. UTF-16 must survive constant evaluation until final UTF-8 emission. Converting individual template substitutions too early corrupts surrogate pairs spanning substitutions.
4. Builtin lowering erases receiver provenance, and dead-code elimination can hide unsupported effects. The closed whitelist inspects the entire original AST before either transform, with explicit depth/data bounds and normal fallback on any unsupported syntax or build context.
5. Core runtime selection needs native-import provenance and dynamic global-object guards; ordinary stdlib feature markers alone missed real FFI and computed-constructor counterexamples.
6. Tiny compiler output must preserve the ordinary text/JSON result contract. Final executable tests compare the required JSON fields and cache envelope, then execute the output.

## Reproduce and audit

[summary.json](summary.json) contains the machine-readable acceptance summary. [inventory.json](inventory.json) records hashes for the curated raw measurements, manifests, build/archive receipts, checks and logs. Raw process samples and failed historical confirmations are retained; binary artifacts and downloaded dependencies are excluded.

Use the helper commands in [CAMPAIGN_HANDOFF.md](../../CAMPAIGN_HANDOFF.md). Rust uses the pinned nightly and LLVM 22; compiler builds use `perry-dev`, runtime archives use unmodified `release`, and Node uses 26.5.1. Build profiles and flags are part of the receipts. These local package tests do not substitute for official distribution compiler builds or CI release gates. Intel coverage is deferred, with no Intel result inferred from the AMD measurements.
