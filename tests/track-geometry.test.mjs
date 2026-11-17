import test from 'node:test';
import assert from 'node:assert/strict';
import { trackSegments, filterTracks, unwrapLongitude } from '../js/track-geometry.js';

function segments(lon, lat = lon.map(() => 10)) {
  return trackSegments({ lon, lat }, { offset: 0, count: lon.length });
}

test('dateline crossings take the short path in both directions', () => {
  assert.deepEqual(segments([179, -179]), [[[179, 10], [181, 10]]]);
  assert.deepEqual(segments([-179, 179]), [[[-179, 10], [-181, 10]]]);
});

test('shared point and line unwrapping preserves exactly 180 degree ties', () => {
  const longitudes = [0, -180, -170];
  const points = [];
  let previous = null;
  for (const longitude of longitudes) {
    previous = unwrapLongitude(longitude, previous);
    points.push(previous);
  }
  assert.deepEqual(points, [0, -180, -170]);
  assert.deepEqual(segments(longitudes)[0].map(point => point[0]), points);
  assert.equal(unwrapLongitude(360), 0);
});

test('unwrapping preserves repeated crossings and multiple revolutions', () => {
  assert.deepEqual(segments([179, -179, 178, -178])[0].map(point => point[0]), [179, 181, 178, 182]);
  assert.deepEqual(segments([0, 120, 240, 360, 480, 600, 720])[0].map(point => point[0]), [0, 120, 240, 360, 480, 600, 720]);
  assert.deepEqual(segments([0, -120, -240, -360, -480])[0].map(point => point[0]), [0, -120, -240, -360, -480]);
});

test('invalid positions break segments without connecting over gaps', () => {
  assert.deepEqual(segments([179, NaN, -179, -178, 12, 13], [10, 10, 11, 12, 91, 14]), [
    [[179, 10]], [[-179, 11], [-178, 12]], [[13, 14]]
  ]);
  assert.deepEqual(segments([NaN, Infinity]), []);
});

test('track bounds and source coordinates are preserved', () => {
  const dataset = { lon: [20, 359, 361, 40], lat: [0, 1, 2, 3] };
  const original = structuredClone(dataset);
  assert.deepEqual(trackSegments(dataset, { offset: 1, count: 2 }), [[[-1, 1], [1, 2]]]);
  assert.deepEqual(dataset, original);
});

const tracks = [
  { id: 'AS0001', realization: '0', basin: 'AS', year: 1980 },
  { id: 'AS0001', realization: '1', basin: 'AS', year: 1980 },
  { id: 'AS0002', realization: '0', basin: 'AS', year: 1982 },
  { id: 'WP0001', realization: '0', basin: 'WP', year: 1981 }
];

test('duplicate storm IDs remain distinct under realization filtering', () => {
  assert.deepEqual(filterTracks(tracks, { query: 'as0001', realization: 0 }), [tracks[0]]);
  assert.deepEqual(filterTracks(tracks, { query: 'AS0001', realization: '1' }), [tracks[1]]);
});

test('query tokens search ID and genesis year, combined with basin and year filters', () => {
  assert.deepEqual(filterTracks(tracks, { query: 'as 1980', basin: 'as' }), tracks.slice(0, 2));
  assert.deepEqual(filterTracks(tracks, { startYear: 1982, endYear: 1981 }), tracks.slice(2));
  assert.deepEqual(filterTracks(tracks, { query: '  ', startYear: '', endYear: '', basin: 'ALL', realization: 'all' }), tracks);
});

test('filtering keeps the input catalogue order and does not mutate it', () => {
  const original = structuredClone(tracks);
  assert.notEqual(filterTracks(tracks), tracks);
  assert.deepEqual(tracks, original);
});
