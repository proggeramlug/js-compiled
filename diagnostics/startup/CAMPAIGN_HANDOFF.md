# Startup campaign handoff — 2026-09-11

Implementation PR: [PerryTS/perry#10066](https://github.com/PerryTS/perry/pull/10066). The compiler automatically specializes strictly proven tiny programs; no enabling flag is required. The agreed local matrix is **AMD Linux x64 and macOS ARM64**. Intel allocator coverage is deferred by explicit user instruction because no host is available. CI belongs to another worker and must not be awaited by the implementation task.

## Source and evidence

- Baseline: `603b074ace01464bc66fc07cc8d532f26ccf5a0f` (0.5.1532).
- Measured combined implementation: `27c598181dfb331d72a798754641082584028df0`.
- Final compiled implementation: `2c08ccfce1a96bfbd825bdedbd591cf47fd88883`, branch `perf/startup-release-candidate` in proggeramlug/perry. Follow-ups fix the Linux fault injector, clarify optional allocator documentation, and preserve the ordinary compiler JSON/text result contract. The JSON fix occurs after native linking; complete native-image comparisons establish whether earlier timing samples still apply.
- Review head: `ef9e56e4ef17a9669bd78b96b4ef2cf0c0ac3057` only numbers/links changelog fragments; all other files are identical to the final compiled source.
- [Final report and raw receipts](evidence/2026-09-11/REPORT.md). Treat its explicit acceptance state as authoritative; historical prototype timings and shared-target runs are not final evidence.
- [Tiny implementation contract](STRICT_TINY_PROPOSAL.md).
- Shared-workspace tracker: `../secret-tests/PERRY_STARTUP_PLAN.md`.

## Integrated changes

| Step | Result | Local verification |
|---|---|---|
| S1 | Reproducible timing, RSS, archive/compiler receipts | Five warmups, A/A calibration, two 100-pair A/B batches, five RSS samples, scriptc and process controls. |
| S2 | Empty checkpoint fast checks; repeated beforeExit fixed | Focused Rust tests, Node lifecycle/error/exit cases, real moving-GC witnesses, trace showing six empty drains without timer passes. |
| S3 | Lazy class-parent storage | First registration and late registration after moving GC; hot inherited-class throughput passes on both hosts. Diagnostics ownership/scanner changes are deferred. |
| S4 | Explicit Linux `PERRY_MEMORY_PROFILE=small` | 12 standalone C and 12 production archive policy/override cases; three fresh Rust process tests. AMD RSS improves 39–44%; throughput tradeoffs are documented. Intel is deferred. |
| S5 | Packaged core runtime, conservative full fallback | Clean compressed npm pack/install outside source; ten core/full feature fixtures, missing-core fallback, and absence of regex/Temporal symbols in the core witness. |
| S6 | General console shortcut rejected | Replacement/diagnostics semantics prevent the unguarded optimization. No such shortcut was shipped. The whole-AST tiny proof is a separate, narrower design. |
| T1–T4 | Automatic tiny proof, minimal entry/helper, semantics and package measurements | 15 positive and 13 fallback executable fixtures; Unicode/NUL/surrogates, stream handshakes and injected write failures; all 22 Node benchmark oracles. |
| S7 | Combined validation | See the report for final acceptance, exact native-image equivalence and the retained noisy Mac map/set runs. |

Tiny hello/noop now take about 1.01 ms and 1.28 MiB peak RSS on the AMD machine; same-host scriptc hello is about 0.98 ms. Mac hello is about 2.25 ms and 1.33 MiB. The report separates same-host measurements from previous CI timings and distinguishes core archive size savings from tiny-path startup savings.

## Reproduction requirements

Use a separate Cargo target directory for each source worktree. A minimal reproduction showed stale native C build-script output being reused across worktrees even when Rust sources and source-ID markers changed. Build full runtime and stdlib archives in **separate** release invocations; copy each archive immutably before the next invocation. Preserve unwind configuration, x64 frame pointers and the pinned toolchain. Compiler builds use `perry-dev`; native runtime archives use unmodified `release` settings. The installed npm layout is real staging/pack/install, but these are locally built compiler artifacts, not a published distribution release.

Do not change source or Git HEAD during matching compiler/archive builds. Node oracles must use the repository pin, 26.5.1. Freeze compiler/archive/binary hashes in each manifest, and validate them before and after timing.

The [comparison instructions](COMPARISON.md) explain the input configuration. Exact executed argument vectors and exit codes are retained in each platform’s `final-compiler/*-commands.json` evidence files.

Harness helpers:

- `prepare-comparison.mjs`, `compare.mjs`: immutable manifests and calibrated startup measurements.
- `verify-workloads.mjs` (optional `--verified-oracles FILE` reuses only complete oracles for the identical immutable manifest), `verify-oracles.mjs`, `verify-fixtures.mjs`, `verify-class-throughput.mjs`: benchmark, lifecycle/GC and class guards.
- `prepare-core-package.py`, `verify-core-package.mjs`: installed package, core/full selection and symbols.
- Perry `scripts/verify_tiny_program.py`, `scripts/verify_tiny_output.py`: executable selection/JSON/output contract and injected native failures.
- `compare-native-images.py`: full ELF/Mach-O comparison. Only exact `git:` source IDs, ELF build-ID notes, Mach-O UUID and code-signature data may differ; code, data, addresses, sizes, relocations and loader commands must match.

The script-only lint mirror passed 75/76 checks. The one public-benchmark freshness failure also occurs on untouched baseline 603b, with identical input fingerprint. Do not regenerate unrelated public performance results to hide it. Focused unit/Clippy/local executable results do not claim a full workspace or full gap-suite pass. Broad CI/release gates remain with their assigned owner.
