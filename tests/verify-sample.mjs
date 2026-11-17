import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildDataset} from '../js/track-data.js';

if (!process.argv[2]) throw new Error('Usage: node tests/verify-sample.mjs /path/to/temporary-reference.json');
const {variables, expected} = JSON.parse(readFileSync(process.argv[2], 'utf8'), (_key, value) => {
  if (value?.__nonfinite__) return {nan: NaN, inf: Infinity, '-inf': -Infinity}[value.__nonfinite__];
  return value;
});
const started = performance.now();
const dataset = buildDataset(variables);
const milliseconds = performance.now() - started;
assert.equal(dataset.stats.pointCount, expected.pointCount);
assert.equal(dataset.stats.trackCount, expected.trackCount);
assert.equal(dataset.stats.realizations.length, expected.realizationCount);
assert.equal(dataset.windUnits, expected.windUnits);
const byKey = new Map(dataset.tracks.map(track => [track.key, track]));
for (const reference of expected.tracks) {
  const actual = byKey.get(reference.key);
  assert.ok(actual, 'Missing track ' + reference.key);
  for (const [field, value] of Object.entries(reference)) assert.equal(actual[field], value, reference.key + ' ' + field);
}
const near = (actual, reference, label) => {
  assert.equal(actual.length, reference.length, label);
  for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - reference[i]) < 1e-10 || Object.is(actual[i], reference[i]), label + '[' + i + ']');
};
for (const sample of expected.samples) {
  const track = byKey.get(sample.key);
  for (const field of ['lon', 'lat', 'time', 'wind']) near(dataset[field].subarray(track.offset, track.offset + track.count), sample[field], sample.key + ' ' + field);
}
const bounds = [Infinity, Infinity, -Infinity, -Infinity];
for (let i = 0; i < dataset.lon.length; i++) {
  if (!Number.isFinite(dataset.lon[i]) || !Number.isFinite(dataset.lat[i])) continue;
  bounds[0] = Math.min(bounds[0], dataset.lon[i]);
  bounds[1] = Math.min(bounds[1], dataset.lat[i]);
  bounds[2] = Math.max(bounds[2], dataset.lon[i]);
  bounds[3] = Math.max(bounds[3], dataset.lat[i]);
}
near(bounds, expected.bounds, 'bounds');
console.log(JSON.stringify({
  ...dataset.stats, realizations: dataset.stats.realizations.length,
  indexedMilliseconds: Math.round(milliseconds), comparedTrackSummaries: expected.tracks.length,
  comparedCompleteTracks: expected.samples.length, bounds
}, null, 2));
