import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { timeRun } from '../../harness/exec.mjs';
import { binaryRecord, checkedRun, experimentEnvironment, validateManifest } from './compare.mjs';

const [manifestFile, packageFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: verify-core-package.mjs STARTUP_MANIFEST PACKAGE_RECEIPT OUTPUT');
const manifest = JSON.parse(readFileSync(manifestFile));
const receipt = JSON.parse(readFileSync(packageFile));
validateManifest(manifest);
const compiler = manifest.variants.candidate.compiler.file;
const install = path.join(receipt.work, 'install');
const result = { manifest, receipt, sizes: {}, fixtures: {}, passed: true };
const save = () => writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
for (const fixture of manifest.cases) {
  const baseline = fixture.commands.baseline.binary.bytes;
  const candidate = fixture.commands.candidate.binary.bytes;
  result.sizes[fixture.name] = { baseline, candidate, savedBytes: baseline - candidate, smaller: candidate < baseline };
  if (candidate >= baseline) result.passed = false;
}
const candidateLibraries = manifest.variants.candidate.runtimeLibraries;
const allTiny = manifest.cases.every(fixture => fixture.commands.candidate.runtimeProfile === 'tiny');
if (!allTiny && !candidateLibraries.some(record => /libperry_runtime_core\.a$/.test(record.file))) throw new Error('No program selected core or tiny');

// Inspect separate unstripped witnesses. Never substitute these larger,
// instrumentable binaries for the ordinary binaries measured above.
result.symbolInspection = {};
const symbolSource = path.join(install, 'symbol-witness.ts');
writeFileSync(symbolSource, 'try { throw new Error("symbols"); } catch (e) { console.log(e.message); }\n');
for (const label of ['baseline', 'candidate']) {
  const binary = symbolSource + `.${label}`;
  const variant = manifest.variants[label];
  const build = await timeRun([compiler, 'compile', symbolSource, '--no-cache', '--debug-symbols', '-v', '-o', binary],
    { env: experimentEnvironment(variant.buildEnv), timeoutMs: 120000 });
  if (!build.ok) throw new Error(`Cannot build symbol witness: ${JSON.stringify(build)}`);
  await checkedRun([binary], { stdout: 'symbols\n', stderr: '' });
  const symbols = spawnSync('nm', [binary], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
  if (symbols.status !== 0 || symbols.error) throw new Error(`Symbol inspection failed: ${symbols.error ?? symbols.stderr}`);
  const log = path.join(path.dirname(outputFile), `symbols-${label}.log`);
  writeFileSync(log, symbols.stdout + symbols.stderr);
  const coreSelected = (build.stdout + build.stderr).includes('using prebuilt core runtime:');
  if (coreSelected !== (label === 'candidate')) throw new Error(`Wrong symbol witness archive for ${label}`);
  result.symbolInspection[label] = { coreSelected, binary: binaryRecord(binary), build, log: binaryRecord(log),
    symbolLines: symbols.stdout.split('\n').filter(Boolean).length,
    regexEngineSymbols: (symbols.stdout.match(/regex_automata|regex_syntax/g) ?? []).length,
    temporalEngineSymbols: (symbols.stdout.match(/temporal_rs/g) ?? []).length };
}
save();

const fixtures = [
  { name: 'core-exceptions', core: true, source: 'try { throw new Error("caught"); } catch (e) { console.log(e.message); }\n' },
  { name: 'regex', source: 'console.log(/a+/.test("aaa"));\n' },
  { name: 'intl', source: 'console.log(new Intl.NumberFormat("en-US").format(1234.5));\n' },
  { name: 'temporal', source: 'console.log(Temporal.PlainDate.from("2020-01-02").toString());\n' },
  { name: 'dynamic-eval', source: 'const body = process.argv[2] || "return n + 1"; console.log(new Function("n", body)(41));\n' },
  ...['globalThis', 'global', 'Function("return this")()'].map((receiver, index) => ({
    name: `computed-global-${index}`, args: ['RegExp'],
    source: `const C: any = (${receiver} as any)[process.argv[2]]; const r: any = new C("a+"); console.log(r.test("aaa"));\n`,
  })),
  { name: 'worker-module', source: 'import { isMainThread } from "node:worker_threads"; console.log(isMainThread);\n' },
  // Node does not provide bun:ffi. Require its known callable export and the
  // full-profile selection, recording this as a surface check, not an FFI ABI test.
  { name: 'ffi-module', expected: { stdout: 'function\n', stderr: '' }, source: 'import { dlopen } from "bun:ffi"; console.log(typeof dlopen);\n' },
];
for (const fixture of fixtures) {
  const row = result.fixtures[fixture.name] = {};
  try {
    const source = path.join(install, `${fixture.name}.ts`);
    writeFileSync(source, fixture.source);
    row.source = binaryRecord(source);
    const oracle = fixture.expected ?? await timeRun([process.execPath, source, ...(fixture.args ?? [])], { env: experimentEnvironment(), timeoutMs: 30000 });
    if (!fixture.expected && !oracle.ok) throw new Error(`Node oracle failed: ${JSON.stringify(oracle)}`);
    row.oracle = { ...oracle, kind: fixture.expected ? 'known-export-surface' : 'Node' };
    const binary = source + '.bin';
    const build = await timeRun([compiler, 'compile', source, '--no-cache', '-v', '-o', binary], { env: experimentEnvironment(), timeoutMs: 120000 });
    row.build = build;
    const selectedCore = (build.stdout + build.stderr).includes('using prebuilt core runtime:');
    if (!build.ok || selectedCore !== (fixture.core === true)) throw new Error(`Wrong build/profile: ${JSON.stringify({ build, selectedCore, expectedCore: fixture.core === true })}`);
    row.binary = binaryRecord(binary);
    row.run = await checkedRun([binary, ...(fixture.args ?? [])], oracle);
  } catch (error) {
    row.error = error.message;
    result.passed = false;
  }
  save();
  console.log(fixture.name, row.error ?? 'passed');
}

// Remove the actual installed compressed archive, then restore it even if
// the fallback fails. The previously extracted cache must not mask absence.
const core = path.join(path.dirname(compiler), '../lib/libperry_runtime_core.a.zst');
const held = core + '.held';
renameSync(core, held);
try {
  const source = path.join(install, 'missing-core.ts');
  writeFileSync(source, 'try { throw new Error("fallback"); } catch (e) { console.log(e.message); }\n');
  const binary = source + '.bin';
  const build = await timeRun([compiler, 'compile', source, '--no-cache', '-v', '-o', binary], { env: experimentEnvironment(), timeoutMs: 120000 });
  result.missingCore = { build };
  if (!build.ok || (build.stdout + build.stderr).includes('using prebuilt core runtime:')) throw new Error('Missing core archive did not fall back');
  result.missingCore.run = await checkedRun([binary], { stdout: 'fallback\n', stderr: '' });
} catch (error) {
  result.missingCore = { ...result.missingCore, error: error.message };
  result.passed = false;
} finally {
  renameSync(held, core);
}
save();
validateManifest(manifest);
if (!result.passed) process.exitCode = 1;
