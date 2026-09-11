import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { timeRun } from '../../harness/exec.mjs';
import { binaryRecord, checkedRun, experimentEnvironment, validateManifest } from './compare.mjs';

const [manifestFile, outputFile] = process.argv.slice(2);
if (!manifestFile || !outputFile) throw new Error('Usage: node verify-fixtures.mjs MANIFEST.json OUTPUT.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const labels = ['baseline', 'candidate'];
validateManifest(manifest, { labels });
const results = { manifest, cases: {}, passed: true };
mkdirSync(path.dirname(outputFile), { recursive: true });
for (const fixture of manifest.cases) {
  const row = results.cases[fixture.name] = {};
  for (const label of labels) {
    const command = fixture.commands[label];
    try {
      const ordinary = await checkedRun(command.argv, fixture.expected, command.env, false, 30000);
      row[label] = { ordinary };
      // These fixtures first take an empty entry checkpoint, then read live
      // runtime roots from beforeExit. Require moving collection to happen.
      if (fixture.name.includes('startup_empty_checkpoint')) {
        const env = { ...command.env, PERRY_GC_SCHEDULE_SEED: '7', PERRY_GC_SCHEDULE_RATE: '1', PERRY_GC_PROTECT_FROMSPACE: '1' };
        const stressed = await timeRun(command.argv, { env: experimentEnvironment(env), timeoutMs: 30000 });
        row[label].gcStress = { env, ...stressed };
        const forced = [...stressed.stderr.matchAll(/forced_collections=(\d+)/g)].some(m => Number(m[1]) > 0);
        const moved = [...stressed.stderr.matchAll(/moved_objects=(\d+)/g)].some(m => Number(m[1]) > 0);
        const remainingStderr = stressed.stderr.split('\n').filter(line => line && !line.startsWith('[gc-schedule]')).join('\n');
        if (!stressed.ok || stressed.stdout !== fixture.expected.stdout || !forced || !moved || remainingStderr) {
          throw new Error(`Moving GC stress did not verify: ${JSON.stringify({ forced, moved, remainingStderr, stressed })}`);
        }
      }
    } catch (error) {
      row[label] = { ...row[label], error: error.message };
      results.passed = false;
    }
  }
  console.log(fixture.name, Object.fromEntries(labels.map(label => [label, row[label].error ? 'failed' : 'passed'])));
  writeFileSync(outputFile, JSON.stringify(results, null, 2) + '\n');
}
// Exit codes are part of the checkpoint contract too. Node's fatal-error
// formatting differs, so require the same exit code and diagnostic sentinel,
// preserving both raw stderr streams for review rather than normalizing stacks.
results.exits = {};
for (const fixture of [
  { name: 'unhandled-exit', code: 1, diagnostic: 'startup rejection sentinel', source: 'Promise.reject("startup rejection sentinel");\n' },
  { name: 'before-exit-code', code: 7, source: 'process.exitCode = 7; process.on("beforeExit", () => console.log("before exit")); process.on("exit", code => console.log("exit", code));\n' },
]) {
  const source = path.resolve(path.dirname(outputFile), `${fixture.name}.ts`);
  writeFileSync(source, fixture.source);
  const oracle = await timeRun([process.execPath, source], { env: experimentEnvironment(), timeoutMs: 30000 });
  if (oracle.exitCode !== fixture.code || oracle.signal || oracle.timedOut) throw new Error(`Invalid exit oracle: ${fixture.name}`);
  const row = results.exits[fixture.name] = { source: binaryRecord(source), oracle };
  for (const label of labels) {
    const variant = manifest.variants[label];
    const binary = path.resolve(path.dirname(outputFile), `${label}-${fixture.name}`);
    const argv = [variant.compiler.file, 'compile', source, ...variant.compileArgs, '-o', binary];
    const build = await timeRun(argv, { env: experimentEnvironment(variant.buildEnv), timeoutMs: 120000 });
    row[label] = { argv, build };
    if (!build.ok) { results.passed = false; continue; }
    row[label].binary = binaryRecord(binary);
    const run = await timeRun([binary], { env: experimentEnvironment(variant.runtimeEnv), timeoutMs: 30000 });
    row[label].run = run;
    const passed = run.exitCode === oracle.exitCode && !run.signal && !run.timedOut && run.stdout === oracle.stdout
      && (fixture.diagnostic ? run.stderr.includes(fixture.diagnostic) : run.stderr === oracle.stderr);
    row[label].passed = passed;
    if (!passed) results.passed = false;
  }
  writeFileSync(outputFile, JSON.stringify(results, null, 2) + '\n');
  console.log(fixture.name, Object.fromEntries(labels.map(label => [label, row[label].passed === true ? 'passed' : 'failed'])));
}
validateManifest(manifest, { labels });
if (!results.passed) process.exitCode = 1;
