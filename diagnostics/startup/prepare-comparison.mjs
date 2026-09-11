import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { binaryRecord, experimentEnvironment } from './compare.mjs';

const root = process.cwd();
const [output = 'results/startup-comparison', configuration] = process.argv.slice(2);
const out = path.resolve(output);
mkdirSync(out, { recursive: true });
const config = configuration ? JSON.parse(readFileSync(configuration, 'utf8')) : {};
const launcher = realpathSync(path.join(root, 'node_modules/.bin/perry'));
const requirePerry = createRequire(launcher);
const { detectPlatform, readHost, PLATFORM_PACKAGES } = requirePerry('./detect.cjs');
const candidates = detectPlatform(readHost()).candidates;
const perry = candidates.flatMap(key => {
  try { return [requirePerry.resolve(`${PLATFORM_PACKAGES[key]}/bin/perry`)]; } catch { return []; }
})[0];
if (!perry) throw new Error('Cannot resolve the native npm Perry compiler');
const scriptc = realpathSync(path.join(root, 'node_modules/.bin/scriptc'));
const flags = ['--no-cache', '-v', ...(config.compileArgs ?? [])];
const settings = config.variants ?? { baseline: { compiler: perry }, candidate: { compiler: perry } };
if (!settings.baseline || !settings.candidate) throw new Error('Both baseline and candidate settings are required');
const allowedBuildEnv = /^(PERRY_(WORKSPACE_ROOT|LIB_DIR|RUNTIME_DIR|NO_AUTO_OPTIMIZE|SIZE_OPT|SIZE_LTO|SIZE_PANIC|EXTRA_LINK_ARGS|TARGET_CPU)|CARGO_TARGET_DIR|CARGO_PROFILE_RELEASE_[A-Z_]+|RUSTFLAGS|MACOSX_DEPLOYMENT_TARGET|CC|CXX|CFLAGS|CXXFLAGS)$/;
const allowedRuntimeEnv = /^(MIMALLOC_[A-Z_]+|mimalloc_[a-z_]+|PERRY_GC_[A-Z_]+|PERRY_MEMORY_PROFILE)$/;
for (const [label, setting] of Object.entries(settings)) {
  for (const key of Object.keys(setting.buildEnv ?? {})) if (!allowedBuildEnv.test(key)) throw new Error(`Unrecordable build setting: ${label}/${key}`);
  for (const key of Object.keys(setting.runtimeEnv ?? {})) if (!allowedRuntimeEnv.test(key)) throw new Error(`Unrecordable runtime setting: ${label}/${key}`);
}

function command(argv, env = {}, log) {
  const result = spawnSync(argv[0], argv.slice(1), { env: experimentEnvironment(env), encoding: 'utf8', timeout: 1200000, maxBuffer: 32 * 1024 * 1024 });
  if (log) writeFileSync(path.join(out, log), `${JSON.stringify(argv)}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error || result.status !== 0) throw new Error(`${argv[0]}: ${result.error ?? result.stderr}`);
  return result;
}

const empty = path.join(out, 'empty.ts');
writeFileSync(empty, '// No user code.\n');
const cases = config.cases
  ? config.cases.map(source => [path.basename(source, path.extname(source)), realpathSync(source)])
  : [['empty', empty], ['noop', path.join(root, 'benches/00-noop.ts')], ['hello', path.join(root, 'benches/01-hello.ts')]];
if (!cases.length || new Set(cases.map(([name]) => name)).size !== cases.length) throw new Error('Cases must have unique, nonempty names');
const manifest = {
  schemaVersion: 1, createdAt: new Date().toISOString(),
  mode: configuration ? 'configured-comparison' : 'unchanged-versus-unchanged',
  harnessCommit: command(['git', 'rev-parse', 'HEAD']).stdout.trim(),
  harnessDiffSha256: (await import('node:crypto')).createHash('sha256').update(command(['git', 'diff', '--', 'harness', 'diagnostics/startup']).stdout).digest('hex'),
  configuration: config,
  node: { ...binaryRecord(process.execPath), version: process.version },
  npmPerryLauncher: binaryRecord(launcher),
  packageLock: binaryRecord(path.join(root, 'package-lock.json')),
  scriptc: { ...binaryRecord(scriptc), version: command([scriptc, '--version']).stdout.trim() },
  ccVersion: command(['cc', '--version']).stdout.trim(),
  variants: {}, cases: [],
};

for (const [label, setting] of Object.entries(settings)) {
  const compiler = realpathSync(setting.compiler ?? perry);
  const version = command([compiler, '--version']).stdout.trim();
  const workspace = setting.buildEnv?.PERRY_WORKSPACE_ROOT;
  manifest.variants[label] = {
    compiler: { ...binaryRecord(compiler), version }, compileArgs: flags,
    buildEnv: setting.buildEnv ?? {}, runtimeEnv: setting.runtimeEnv ?? {}, runtimeLibraries: [],
    source: workspace ? {
      root: workspace,
      commit: command(['git', '-C', workspace, 'rev-parse', 'HEAD']).stdout.trim(),
      trackedDiff: command(['git', '-C', workspace, 'diff', 'HEAD']).stdout,
    } : null,
  };
  mkdirSync(path.join(out, label), { recursive: true });
}

for (const [name, source] of cases) {
  const oracle = command([process.execPath, source]);
  const fixture = { name, source: binaryRecord(source), expected: { stdout: oracle.stdout, stderr: oracle.stderr }, commands: {}, gcStress: config.gcStressCases?.includes(name) === true };
  for (const [label, setting] of Object.entries(settings)) {
    const variant = manifest.variants[label];
    const identicalBuild = label === 'candidate' && variant.compiler.sha256 === manifest.variants.baseline.compiler.sha256
      && JSON.stringify(variant.buildEnv) === JSON.stringify(manifest.variants.baseline.buildEnv);
    let binary;
    if (identicalBuild) {
      binary = fixture.commands.baseline.argv[0];
      variant.runtimeLibraries = manifest.variants.baseline.runtimeLibraries;
    } else {
      binary = path.join(out, label, name);
      const built = command([variant.compiler.file, 'compile', source, ...flags, '-o', binary], variant.buildEnv, `${label}-${name}-build.log`);
      const text = built.stdout + built.stderr;
      // Record the archives actually used in the verbose linker invocation,
      // including abort/auto-optimized variants, rather than guessing by version.
      const link = text.split('\n').find(line => line.includes('[link] invoking:'));
      if (!link) throw new Error(`Missing linker receipt: ${label}/${name}`);
      const libraries = [...new Set([...link.matchAll(/(\/[^\s"']*libperry_[^\s"']+\.a)(?=\s|$)/g)].map(match => match[1]))];
      if (!libraries.some(file => /libperry_runtime(?:_abort|_core)?\.a$/.test(file))) {
        throw new Error(`Cannot identify runtime archive in linker receipt: ${label}/${name}`);
      }
      for (const file of libraries) if (!variant.runtimeLibraries.some(record => record.file === file)) variant.runtimeLibraries.push(binaryRecord(file));
    }
    fixture.commands[label] = { argv: [binary], binary: binaryRecord(binary), env: variant.runtimeEnv };
  }
  if (config.scriptc !== false) {
    const binary = path.join(out, `scriptc-${name}`);
    command([scriptc, 'build', source, '-o', binary], {}, `scriptc-${name}-build.log`);
    fixture.commands.scriptc = { argv: [binary], binary: binaryRecord(binary), env: {} };
  }
  manifest.cases.push(fixture);
  // Keep completed build receipts if a later, larger fixture fails.
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Prepared ${name}`);
}
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${manifest.mode}: ${path.join(out, 'manifest.json')}`);
