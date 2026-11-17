import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDataset, decodeNumeric, decodeTime} from '../js/track-data.js';

function variables(overrides = {}) {
  const data = {
    storm: {values: ['AS01', 'AS01', 'AS01', 'AS01']},
    realization: {values: [0n, 1n, 0n, 0n]},
    time: {values: [12n, 0n, 0n, 6n], attributes: {units: 'hours since 2000-01-01 00:00:00', calendar: 'proleptic_gregorian'}},
    lon: {values: [181, 40, 179, 180]},
    lat: {values: [12, 15, 10, 11]},
    wind: {values: [40, 20, 30, 35]},
    state: {values: ['S1', '', 'S0', 'S1']}
  };
  return {...data, ...overrides};
}

test('decodes packed values after testing fill and missing values', () => {
  const decoded = decodeNumeric(new Int16Array([0, 10, -999, -888]), {
    scale_factor: new Float32Array([0.5]), add_offset: 5,
    _FillValue: new Int16Array([-999]), missing_value: -888
  });
  assert.deepEqual(Array.from(decoded), [5, 10, NaN, NaN]);
});

test('converts CF times, offsets, negative times, and small years in UTC', () => {
  assert.deepEqual(Array.from(decodeTime([-1n, 0n, 6n], {
    units: 'hours since 1980-11-05 00:00:00', calendar: 'proleptic_gregorian'
  })).map(value => new Date(value).toISOString()), [
    '1980-11-04T23:00:00.000Z', '1980-11-05T00:00:00.000Z', '1980-11-05T06:00:00.000Z'
  ]);
  assert.equal(new Date(decodeTime([0], {units: 'seconds since 2000-01-01 01:30:00 +01:30'})[0]).toISOString(), '2000-01-01T00:00:00.000Z');
  assert.equal(new Date(decodeTime([0], {units: 'days since 0020-01-01', calendar: 'proleptic_gregorian'})[0]).getUTCFullYear(), 20);
  assert.equal(decodeTime([2], {units: 'minutes since 2000-01-01'})[0], Date.UTC(2000, 0, 1, 0, 2));
});

test('rejects unsupported calendars, invalid dates, and missing timestamps', () => {
  assert.throws(() => decodeTime([0], {units: 'days since 2000-01-01', calendar: '360_day'}), /Unsupported calendar/);
  assert.throws(() => decodeTime([0], {units: 'days since 2001-02-29'}), /Invalid time reference/);
  assert.throws(() => decodeTime([NaN], {units: 'hours since 2000-01-01'}), /invalid timestamp/);
  assert.throws(() => decodeTime([0], {units: 'days since 1500-01-01'}), /1582-10-15/);
  assert.throws(() => decodeTime([200000], {units: 'days since 1500-01-01'}), /Time references before 1582-10-15/);
});

test('keeps repeated storm IDs in different realizations separate and sorts complete rows', () => {
  const data = buildDataset(variables());
  assert.equal(data.tracks.length, 2);
  assert.notEqual(data.tracks[0].key, data.tracks[1].key);
  assert.deepEqual(data.tracks.map(({id, realization, offset, count}) => ({id, realization, offset, count})), [
    {id: 'AS01', realization: '0', offset: 0, count: 3}, {id: 'AS01', realization: '1', offset: 3, count: 1}
  ]);
  assert.deepEqual(Array.from(data.lon), [179, -180, -179, 40]);
  assert.deepEqual(Array.from(data.wind), [30, 35, 40, 20]);
  assert.deepEqual(Array.from(data.stateCodes).map(code => data.states[code]), ['S0', 'S1', 'S1', '']);
  assert.equal(data.tracks[0].maxWind, 40);
  assert.equal(data.windUnits, '');
  assert.equal(data.stats.pointCount, 4);
});

test('preserves invalid-coordinate gaps instead of connecting across missing points', () => {
  const data = buildDataset(variables({lat: {values: [12, 15, 10, 95]}}));
  assert.deepEqual(Array.from(data.lon), [179, NaN, -179, 40]);
  assert.equal(data.tracks[0].count, 3);
  assert.equal(data.tracks[0].validCount, 2);
  assert.equal(data.stats.pointCount, 3);
  assert.equal(data.stats.skippedPoints, 1);
  assert.match(data.warnings[0], /gaps are preserved/);
});

test('optional fields default without inventing units or wind values', () => {
  const input = variables();
  delete input.wind;
  delete input.realization;
  delete input.state;
  const data = buildDataset(input);
  assert.equal(data.tracks.length, 1);
  assert.equal(data.tracks[0].realization, '0');
  assert.ok(data.wind.every(Number.isNaN));
  assert.deepEqual(data.states, ['']);
});

test('rejects incompatible shapes, missing identifiers, and wholly invalid positions', () => {
  assert.throws(() => buildDataset(variables({lon: {values: [1]}})), /expected 4 rows/);
  assert.throws(() => buildDataset(variables({storm: {values: ['', 'AS01', 'AS01', 'AS01']}})), /missing identifier/);
  assert.throws(() => buildDataset(variables({lat: {values: [NaN, NaN, NaN, NaN]}})), /no valid track positions/);
  const input = variables();
  delete input.time;
  assert.throws(() => buildDataset(input), /Missing required variable "time"/);
});
