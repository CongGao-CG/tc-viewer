import test from 'node:test';
import assert from 'node:assert/strict';
import { DatasetCollection } from '../js/dataset-collection.js';
import { filterTracks, trackSegments } from '../js/track-geometry.js';

function dataset(longitude, year = 1980) {
  return {
    lon: new Float64Array([longitude, longitude + 1]), lat: new Float64Array([10, 11]),
    tracks: [{ key: '["0","AS0001"]', id: 'AS0001', realization: '0', basin: 'AS', year, offset: 0, count: 2, validCount: 2 }],
    stats: { pointCount: 2, minYear: year, maxYear: year, realizations: ['0'], basins: ['AS'] },
  };
}

test('identical track and realization IDs in two files stay distinct and read their own coordinates', () => {
  const collection = new DatasetCollection();
  const firstData = dataset(40), secondData = dataset(80);
  const first = collection.add({ name: 'tracks.nc', size: 10 }, firstData);
  const second = collection.add({ name: 'tracks.nc', size: 10 }, secondData);
  assert.notEqual(first.tracks[0].key, second.tracks[0].key);
  assert.notEqual(first.name, second.name);
  assert.equal(collection.dataFor(first.tracks[0]).lon, firstData.lon);
  assert.equal(collection.dataFor(second.tracks[0]).lon, secondData.lon);
  assert.deepEqual(trackSegments(collection.dataFor(second.tracks[0]), second.tracks[0]), [[[80, 10], [81, 11]]]);
  assert.deepEqual(filterTracks(collection.tracks, { sourceId: first.id, query: 'AS0001' }), first.tracks);
  assert.equal(firstData.tracks[0].sourceId, undefined);
});

test('removing files updates union filters and totals without changing remaining identity or color', () => {
  const collection = new DatasetCollection();
  const first = collection.add({ name: 'early.nc', size: 10 }, dataset(40, 1980));
  const second = collection.add({ name: 'late.nc', size: 10 }, dataset(80, 2024));
  const savedKey = second.tracks[0].key, savedColor = second.color;
  assert.deepEqual(collection.stats, { fileCount: 2, trackCount: 2, pointCount: 4, minYear: 1980, maxYear: 2024, basins: ['AS'], realizations: ['0'] });
  collection.remove(first.id);
  assert.equal(collection.stats.minYear, 2024);
  assert.equal(collection.stats.pointCount, 2);
  assert.equal(collection.dataFor(first.tracks[0]), undefined);
  assert.equal(collection.tracks[0].key, savedKey);
  assert.equal(collection.sources.get(second.id).color, savedColor);
  collection.clear();
  assert.equal(collection.stats.fileCount, 0);
  assert.equal(collection.stats.minYear, null);
  assert.deepEqual(collection.tracks, []);
});

test('same-name additions remain unambiguous after individual files are removed', () => {
  const collection = new DatasetCollection();
  const first = collection.add({ name: 'tracks.nc', size: 10 }, dataset(40));
  collection.add({ name: 'tracks.nc', size: 10 }, dataset(80));
  collection.remove(first.id);
  collection.add({ name: 'tracks.nc', size: 10 }, dataset(90));
  collection.add({ name: 'tracks.nc', size: 10 }, dataset(100));
  assert.equal(new Set([...collection.sources.values()].map(source => source.name)).size, 3);
  assert.equal(new Set(collection.tracks.map(track => track.key)).size, 3);
});
