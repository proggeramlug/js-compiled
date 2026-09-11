// Confirm a noisy default-profile slowdown without discarding the first run.
// Always collect 20 further A/B pairs and pool them with the original samples.
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { binaryRecord, checkedRun, distribution, pairedDifference, sha256, validateManifest } from './compare.mjs';

const [originalFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: confirm-throughput.mjs ORIGINAL_VERIFICATION OUTPUT');
const original = JSON.parse(readFileSync(originalFile));
if (!original.finishedAt || original.settings.recordTradeoffs) throw new Error('Requires a completed default-profile run');
const manifest = original.manifest;
const labels = ['baseline', 'candidate'];
validateManifest(manifest, { labels });
const result = {
  original: binaryRecord(originalFile), code: binaryRecord(fileURLToPath(import.meta.url)),
  settings: { warmups: 5, calibrationPairs: 10, furtherPairs: 20, threshold: 0.03 },
  host: { platform: process.platform, cpu: cpus()[0]?.model, kernel: release(), loadBefore: loadavg() },
  cases: {}, complete: false, passed: false,
};
const save = () => writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
for (const [name, previous] of Object.entries(original.cases)) {
  if (!previous.throughput || previous.throughput.medianRatio <= 1.03) continue;
  if (previous.error || labels.some(label => !previous.oracle[label]?.matchesNode)) throw new Error('Cannot resolve an oracle failure with timing');
  const fixture = manifest.cases.find(fixture => fixture.name === name);
  const run = async label => {
    const command = fixture.commands[label];
    return (await checkedRun(command.argv, fixture.expected, command.env, false, 300000)).wallMs;
  };
  for (let i = 0; i < 5; i++) for (const label of labels) await run(label);
  const row = result.cases[name] = { calibration: { baseline: [], candidate: [] }, further: { baseline: [], candidate: [] } };
  for (let i = 0; i < 10; i++) for (const label of i % 2 ? [...labels].reverse() : labels) row.calibration[label].push(await run('baseline'));
  row.calibration.pairedDifference = pairedDifference(row.calibration.baseline, row.calibration.candidate);
  for (let i = 0; i < 20; i++) {
    for (const label of i % 2 ? [...labels].reverse() : labels) row.further[label].push(await run(label));
    save();
  }
  row.pooled = Object.fromEntries(labels.map(label => [label,
    distribution([...previous.throughput[label].samples, ...row.further[label]])]));
  row.furtherMedianRatio = distribution(row.further.candidate).median / distribution(row.further.baseline).median;
  row.pooledMedianRatio = row.pooled.candidate.median / row.pooled.baseline.median;
  row.pooledPairedDifference = pairedDifference(row.pooled.baseline.samples, row.pooled.candidate.samples);
  row.passed = row.furtherMedianRatio <= 1.03 && row.pooledMedianRatio <= 1.03;
  console.log(name, JSON.stringify({ furtherMedianRatio: row.furtherMedianRatio, pooledMedianRatio: row.pooledMedianRatio, passed: row.passed }));
  save();
}
if (!Object.keys(result.cases).length) throw new Error('No slowdown required confirmation');
validateManifest(manifest, { labels });
if (sha256(originalFile) !== result.original.sha256) throw new Error('Original evidence changed');
result.host.loadAfter = loadavg();
result.complete = true;
result.passed = Object.values(result.cases).every(row => row.passed);
save();
if (!result.passed) process.exitCode = 1;
