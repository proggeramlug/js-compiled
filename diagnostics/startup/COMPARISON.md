# Startup acceptance measurements

Install the lockfile dependencies with `npm ci`, then run:

```sh
node --test harness/exec.test.mjs diagnostics/startup/compare.test.mjs
node diagnostics/startup/prepare-comparison.mjs
node diagnostics/startup/compare.mjs results/startup-comparison/manifest.json results/startup-comparison/measurements.json
```

With no configuration, both labels use the same released executable. This is
the S1 unchanged-versus-unchanged check, not an optimization experiment.

For a candidate compiler/runtime, provide a JSON configuration:

```json
{
  "compileArgs": [],
  "variants": {
    "baseline": {
      "compiler": "/path/to/baseline/perry",
      "buildEnv": {"PERRY_WORKSPACE_ROOT": "/path/to/baseline/source"},
      "runtimeEnv": {}
    },
    "candidate": {
      "compiler": "/path/to/candidate/perry",
      "buildEnv": {"PERRY_WORKSPACE_ROOT": "/path/to/candidate/source"},
      "runtimeEnv": {}
    }
  }
}
```

```sh
node diagnostics/startup/prepare-comparison.mjs results/candidate-a candidate.json
node diagnostics/startup/compare.mjs results/candidate-a/manifest.json results/candidate-a/measurements.json
```

Compiler flags are shared. Runtime-only experiments can point both variants at
the same compiler and provide an explicit runtime environment such as
`{"MIMALLOC_ALLOW_THP":"0"}` for the candidate. Build the compiler/runtime with
matching toolchains and profiles. The preparer records the actual native Perry
compiler, runtime archives from the verbose linker command, sources, binaries,
flags, package lock, and source commit/diff when using a workspace. Unsupported
receipt layouts fail instead of producing an unverifiable result.

For each input the runner executes five warmups, a 100-pair calibration using
the exact baseline binary twice, then two 100-pair A/B batches. Pair order
alternates; `/usr/bin/true` and scriptc run as controls. Five separate peak-RSS
launches use GNU time on Linux and BSD time on macOS. Outputs must match Node.
The measurement tool checks file hashes before and after running.

The report retains all samples and computes median, p90, and a deterministic
paired-bootstrap 95% interval. A speed win is reported only when both A/B
intervals beat the calibration noise bound. Otherwise the result is
inconclusive or a repeatable regression. This is a screening rule for warm
startup, not a guarantee against every shared-runner disturbance or a substitute
for the plan's correctness/throughput checks. Do not compare times from
different CPUs as an A/B experiment.

The `startup comparison` workflow runs the unchanged check on Linux x64 and
macOS ARM64; [GitHub documents the macos-15 label as ARM64](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Keep measurements in `results/`; the workflow uploads them as artifacts.
