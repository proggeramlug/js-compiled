// The class-table initialization check also sits on hot inherited-class reads.
// Keep this witness separate from whole-process startup measurements.
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, release, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { binaryRecord, checkedRun, distribution, pairedDifference, validateManifest } from './compare.mjs';

const [manifestFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: verify-class-throughput.mjs MANIFEST OUTPUT');
const manifest = JSON.parse(readFileSync(manifestFile));
validateManifest(manifest);
if (manifest.cases.length !== 1 || manifest.cases[0].name !== 'class-parent-throughput') {
  throw new Error('Expected the inherited-class throughput witness');
}
const fixture = manifest.cases[0];
const labels = ['baseline', 'candidate'];
const result = {
  manifest, code: binaryRecord(fileURLToPath(import.meta.url)), startedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, kernel: release(), loadBefore: loadavg() },
  settings: { warmups: 5, pairedSamples: 10, slowdownThreshold: 0.03 },
  raw: { baseline: [], candidate: [] },
};
const run = async label => {
  const command = fixture.commands[label];
  return checkedRun(command.argv, fixture.expected, command.env);
};
for (let i = 0; i < 5; ++i) for (const label of labels) await run(label);
for (let i = 0; i < 10; ++i) {
  for (const label of i % 2 ? [...labels].reverse() : labels) result.raw[label].push((await run(label)).wallMs);
  writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
}
result.baseline = distribution(result.raw.baseline);
result.candidate = distribution(result.raw.candidate);
result.pairedDifference = pairedDifference(result.raw.baseline, result.raw.candidate);
result.medianRatio = result.candidate.median / result.baseline.median;
result.assessment = result.medianRatio > 1.03
  ? (result.pairedDifference.ci95Ms[0] > 0 ? 'regression-needs-explanation' : 'inconclusive-needs-rerun')
  : 'no-slowdown-over-3pct-observed';
result.passed = result.medianRatio <= 1.03;
result.host.loadAfter = loadavg();
result.finishedAt = new Date().toISOString();
validateManifest(manifest);
writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
console.log(result.assessment, result.medianRatio);
if (!result.passed) process.exitCode = 1;
