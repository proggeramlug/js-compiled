import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { cpus, release, totalmem, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timeRun, rssRun, stats } from '../../harness/exec.mjs';

export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export const binaryRecord = file => ({ file, bytes: statSync(file).size, sha256: sha256(file) });

// Start from the same environment, excluding ambient experiment knobs. Each
// manifest explicitly supplies its variant's compiler/runtime settings.
export function experimentEnvironment(overrides = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(PERRY_|MIMALLOC_|LD_PRELOAD$|LD_DEBUG$|DYLD_INSERT_LIBRARIES$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|CARGO_PROFILE_|CARGO_TARGET_DIR$|CC$|CXX$|CFLAGS$|CXXFLAGS$|MACOSX_DEPLOYMENT_TARGET$)/.test(key))),
    ...overrides,
  };
}

export function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { ...stats(samples), p90: sorted[Math.ceil(sorted.length * .9) - 1], samples };
}

export function pairedDifference(before, after, iterations = 2000) {
  if (before.length !== after.length || before.length < 2) throw new Error('Invalid paired samples');
  const differences = before.map((value, i) => after[i] - value);
  let seed = 0x5eeda11;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
  const boot = Array.from({ length: iterations }, () => stats(Array.from({ length: differences.length }, () =>
    differences[Math.floor(random() * differences.length)])).median).sort((a, b) => a - b);
  return { medianMs: stats(differences).median, ci95Ms: [boot[Math.floor(iterations * .025)], boot[Math.ceil(iterations * .975) - 1]] };
}

export async function checkedRun(command, expected, env = {}, rss = false, timeoutMs = 10000) {
  const result = await (rss ? rssRun : timeRun)(command, { env: experimentEnvironment(env), timeoutMs });
  if (!result.ok || result.stdout !== expected.stdout || (!rss && result.stderr !== expected.stderr)) {
    throw new Error(`Command failed verification: ${JSON.stringify({ command, expected, result })}`);
  }
  // GNU time writes its measurement separately; BSD time appends it to stderr.
  if (rss && process.platform !== 'darwin' && result.stderr !== expected.stderr) {
    throw new Error(`Unexpected stderr during RSS run: ${result.stderr}`);
  }
  return result;
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !manifest.cases?.length) throw new Error('Unsupported/empty manifest');
  for (const fixture of manifest.cases) {
    if (sha256(fixture.source.file) !== fixture.source.sha256) throw new Error(`Source changed: ${fixture.name}`);
    for (const label of ['baseline', 'candidate', 'scriptc']) {
      const command = fixture.commands[label];
      if (sha256(command.argv[0]) !== command.binary.sha256) throw new Error(`Binary changed: ${fixture.name}/${label}`);
    }
  }
  for (const variant of Object.values(manifest.variants)) {
    for (const record of [variant.compiler, ...variant.runtimeLibraries]) {
      if (sha256(record.file) !== record.sha256) throw new Error(`Build artifact changed: ${record.file}`);
    }
  }
}

export async function compare(manifest, { samples = 100, warmups = 5, rssSamples = 5, batches = 2 } = {}) {
  for (const [key, value] of Object.entries({ samples, warmups, rssSamples, batches })) {
    if (!Number.isInteger(value) || value < (key === 'samples' ? 2 : 1)) throw new Error(`Invalid ${key}`);
  }
  validateManifest(manifest);
  const result = {
    schemaVersion: 1, startedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, kernel: release(), cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, memoryBytes: totalmem(), loadBefore: loadavg(), node: process.version },
    measurementCode: [fileURLToPath(import.meta.url), fileURLToPath(new URL('../../harness/exec.mjs', import.meta.url))].map(binaryRecord),
    settings: { samples, warmups, rssSamples, batches }, manifest, cases: {},
  };
  for (const fixture of manifest.cases) {
    const { commands, expected } = fixture;
    const row = result.cases[fixture.name] = { calibration: {}, batches: [], rssKiB: {} };
    for (const command of Object.values(commands)) for (let i = 0; i < warmups; ++i) {
      await checkedRun(command.argv, expected, command.env);
    }
    // Each pair is adjacent; alternate A/B ordering. Calibration is the exact
    // same binary/environment under two labels, not a second recompilation.
    for (let batch = -1; batch < batches; ++batch) {
      const first = commands.baseline;
      const second = batch < 0 ? first : commands.candidate;
      const before = [], after = [], spawn = [], scriptc = [];
      for (let round = 0; round < samples; ++round) {
        const pair = [[first, before], [second, after]];
        if ((round + batch + 1) % 2) pair.reverse();
        for (const [command, values] of pair) values.push((await checkedRun(command.argv, expected, command.env)).wallMs);
        spawn.push((await checkedRun(['/usr/bin/true'], { stdout: '', stderr: '' })).wallMs);
        scriptc.push((await checkedRun(commands.scriptc.argv, expected, commands.scriptc.env)).wallMs);
      }
      const measurement = { baseline: distribution(before), candidate: distribution(after),
        pairedDifference: pairedDifference(before, after), spawn: distribution(spawn), scriptc: distribution(scriptc) };
      if (batch < 0) row.calibration = measurement;
      else row.batches.push(measurement);
    }
    for (const label of ['baseline', 'candidate', 'scriptc']) {
      const command = commands[label];
      const samples = [];
      for (let i = 0; i < rssSamples; ++i) samples.push((await checkedRun(command.argv, expected, command.env, true)).maxRssKb);
      row.rssKiB[label] = distribution(samples);
    }
    const noise = Math.max(Math.abs(row.calibration.pairedDifference.medianMs), ...row.calibration.pairedDifference.ci95Ms.map(Math.abs));
    row.noiseBoundMs = noise;
    row.assessment = row.batches.every(b => b.pairedDifference.ci95Ms[1] < -noise) ? 'repeatable-win'
      : row.batches.every(b => b.pairedDifference.ci95Ms[0] > noise) ? 'repeatable-regression' : 'inconclusive';
    console.log(fixture.name, JSON.stringify({ noiseBoundMs: noise, assessment: row.assessment,
      medians: row.batches.map(b => [b.baseline.median, b.candidate.median]),
      rssKiB: Object.fromEntries(Object.entries(row.rssKiB).map(([k, v]) => [k, v.max])) }));
  }
  validateManifest(manifest);
  result.host.loadAfter = loadavg();
  result.finishedAt = new Date().toISOString();
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestFile, outputFile] = process.argv.slice(2);
  if (!manifestFile || !outputFile) throw new Error('Usage: node compare.mjs MANIFEST.json OUTPUT.json');
  const result = await compare(JSON.parse(readFileSync(manifestFile, 'utf8')));
  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
}
