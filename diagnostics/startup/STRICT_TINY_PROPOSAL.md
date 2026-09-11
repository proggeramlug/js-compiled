# Automatic tiny-program specialization — implemented design

Implemented in [Perry PR #10066](https://github.com/PerryTS/perry/pull/10066). Requirements: automatic compiler selection with no user flag; strict, conservative eligibility; limited coverage is acceptable. The compiler/runtime implementation is pinned by the [campaign evidence](evidence/2026-09-11/REPORT.md).

Ordinary `perry compile app.ts` runs an eligibility check. A proof selects the tiny implementation; an unsupported or unproven construct selects the normal compiler/runtime path. Ineligibility is not a compilation error. Verbose diagnostics explain which path was selected and why, without requiring a user flag to enable specialization.

## Two independent requirements

1. No asynchronous or lifecycle work: no tasks/microtasks, promises, timers, workers, native callbacks, dynamic loading, process listeners, finalizers, or host/plugin entry points.
2. No managed heap requirement: the generated body and every reachable helper allocate no managed objects. Merely being synchronous or short is insufficient. A synchronous allocation loop still requires normal memory management.

Version one requires **no managed allocations**, avoiding a speculative allocation budget. Static string bytes are emitted in read-only storage and printed by a minimal native helper. That helper must not pull in the ordinary console formatter, GC arena, class tables, mimalloc, root registration, or promise/event-loop machinery. OS/libc buffering is separate from the JS managed heap; its allocation must be measured rather than described as literally allocation-free.

## Initial accepted language subset

The accepted subset is standalone executables containing an empty body or direct `console.log` / `console.error` calls with one statically known string argument. Allow immutable string bindings and constant templates only when a small evaluator proves every original expression is side-effect-free and the console receiver is the unshadowed builtin. This covers the benchmark’s ``const who = "world"; console.log(`hello, ${who}`)`` without runtime string allocation. Primitive arithmetic, numeric formatting and loops are later expansions, not implicitly permitted in the first version.

Treat every other AST/HIR construct as ineligible by default. In particular, retain the normal runtime for imports (until transitive effect summaries exist), unknown calls, aliases, shadowing or writes to console, dynamic property access, getters/setters, objects/arrays/classes/closures, dynamic evaluation, async constructs, process lifecycle/trace APIs, exceptions requiring the ordinary runtime, and embedding/library targets. Eligibility analysis must inspect the entire program before unreachable-code elimination or constant folding can conceal an unsupported semantic effect.

Receiver provenance must be preserved before the current lowering collapses builtin receivers to `GlobalGet(0)`. The existing shared sentinel is not a proof of console identity. Every emitted helper also needs an explicit supported-effect contract; an accepted source construct cannot call a helper that reintroduces GC or scheduling indirectly.

## Acceptance gates

- Ordinary compilation automatically selects tiny only for proven programs. Each ineligible fixture selects the normal path, with an inspectable reason; ineligibility alone never fails compilation.
- Positive Node oracles: empty body, literal/constant-template stdout/stderr, multiple calls and ordering, Unicode, embedded NUL, percent characters, empty strings and final newlines. Include closed/broken pipes and write errors; simply substituting `puts` does not establish console parity.
- Fallback-selection fixtures: each excluded syntax/effect, including nested functions/classes, console shadowing or reassignment during argument evaluation, computed access, eval/import/worker/native callback paths, and a synchronous allocating loop.
- Inspect generated IR and linked symbols: no GC initialization/collection/root APIs, managed allocations, event-loop/promise initialization, class registry, or full runtime archive. Keep the emitted helper dependency list in the receipt.
- Separate positive eligibility from the 22-benchmark suite: most benchmarks are expected to select the normal runtime. All 22 must still execute and match Node through ordinary automatic compilation; fallback selection is not an oracle pass by itself.
- Measure the actual installed automatically specialized binary versus normal Perry, scriptc and process-spawn controls with the established A/A and repeated A/B methodology. Report file size, RSS, timing and exact accepted-language coverage. No numerical startup promise before measurements.

## Tracking steps

| Done | Step | Verification before closing |
|---|---|---|
| [x] | T1: strict eligibility and automatic fallback | Positive fixtures qualify; every excluded construct uses normal runtime with an inspectable reason. No enabling flag. |
| [x] | T2: minimal entry and printing helper | Generated IR and linked symbols contain none of the excluded runtime facilities. |
| [x] | T3: output and fallback semantics | Node output/error cases pass; all 22 benchmarks still execute correctly under automatic selection. |
| [x] | T4: installed-package measurements | Clean npm install, Linux/macOS A/A and repeated A/B, exact hashes and raw timing/RSS/size evidence. |

All four steps have local evidence on AMD Linux and macOS ARM64. T1–T3 cover 15 accepted and 13 fallback executable fixtures, 11 tiny-specific Rust tests, 22 Node benchmark oracles, generated IR/symbol inspection, and fault-injected native output. T4 uses a clean compressed npm pack/install, A/A calibration, two 100-pair A/B batches, and five RSS samples. See the linked campaign report for exact source identities and raw results. Intel is deferred at the user’s request; CI belongs to another worker.

The helper uses two stack cursors and bounded native polling only when pipe/socket backpressure requires it; it does not introduce a JS event loop. It handles stdout and stderr independently to avoid a reader/writer handshake deadlock. UTF-16 is preserved until final UTF-8 conversion, including surrogate pairs across template substitutions. Analysis has explicit depth and aggregate-data bounds; exceeding them selects the normal pipeline.
