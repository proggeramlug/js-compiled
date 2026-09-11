import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { timeRun } from '../../harness/exec.mjs';
import { checkedRun, experimentEnvironment, validateManifest } from './compare.mjs';

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
validateManifest(manifest, { labels });
if (!results.passed) process.exitCode = 1;
