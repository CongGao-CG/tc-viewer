const REQUIRED = ['storm', 'time', 'lon', 'lat'];
const GREGORIAN_START = Date.UTC(1582, 9, 15);

function scalar(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value) ? value[0] : value;
}

function attributeValues(value) {
  if (value === undefined) return [];
  return Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : [value];
}

export function decodeNumeric(values, attributes = {}, name = 'variable') {
  const fills = [...attributeValues(attributes._FillValue), ...attributeValues(attributes.missing_value)];
  const scale = Number(scalar(attributes.scale_factor) ?? 1);
  const offset = Number(scalar(attributes.add_offset) ?? 0);
  if (!Number.isFinite(scale) || !Number.isFinite(offset)) {
    throw new Error(`${name}: scale_factor and add_offset must be finite numbers.`);
  }
  if (String(scalar(attributes._Unsigned)).toLowerCase() === 'true') {
    throw new Error(`${name}: packed _Unsigned variables are not supported. Export an unpacked numeric variable.`);
  }
  const decoded = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (fills.some(fill => raw === fill || (typeof raw !== 'bigint' && Number(raw) === Number(fill)))) {
      decoded[i] = NaN;
      continue;
    }
    if (typeof raw !== 'number' && typeof raw !== 'bigint') {
      throw new Error(`${name}: expected numeric values, found a nonnumeric value at row ${i + 1}.`);
    }
    if (typeof raw === 'bigint' && (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER))) {
      throw new Error(`${name}: an integer at row ${i + 1} exceeds the browser's exact numeric range.`);
    }
    decoded[i] = Number(raw) * scale + offset;
  }
  return decoded;
}

function referenceTime(text) {
  const match = text.trim().match(/^([+-]?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2})(?::(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?)?)?(?:\s*(Z|UTC|[+-]\d{1,2}(?::?\d{2})?))?$/i);
  if (!match) throw new Error(`Unsupported time reference: "${text}". Use a Gregorian date with an optional UTC offset.`);
  const [, y, m, d, hh = '0', mm = '0', ss = '0', fraction = '', zone = 'Z'] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const hour = Number(hh), minute = Number(mm), second = Number(ss);
  const millisecond = Number((fraction + '000').slice(0, 3));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid time reference: "${text}".`);
  }
  let zoneMinutes = 0;
  if (/^[+-]/.test(zone)) {
    const parts = zone.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
    const hours = Number(parts[2]), minutes = Number(parts[3] || 0);
    if (hours > 23 || minutes > 59) throw new Error(`Invalid UTC offset: "${zone}".`);
    zoneMinutes = (parts[1] === '+' ? 1 : -1) * (hours * 60 + minutes);
  }
  return date.getTime() - zoneMinutes * 60000;
}

export function decodeTime(values, attributes = {}) {
  const units = String(scalar(attributes.units) ?? '');
  const calendar = String(scalar(attributes.calendar) ?? 'standard').trim().toLowerCase();
  if (!['standard', 'gregorian', 'proleptic_gregorian'].includes(calendar)) {
    throw new Error(`Unsupported calendar "${calendar}". Use standard, gregorian, or proleptic_gregorian dates.`);
  }
  const match = units.trim().match(/^(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h|days?|d)\s+since\s+(.+)$/i);
  if (!match) throw new Error('time.units must specify milliseconds, seconds, minutes, hours, or days since a reference date.');
  const unit = match[1].toLowerCase();
  const multiplier = /^(millisecond|msec|ms)/.test(unit) ? 1 : /^(second|sec|s)/.test(unit) ? 1000 : /^(minute|min)/.test(unit) ? 60000 : /^(hour|hr|h)/.test(unit) ? 3600000 : 86400000;
  const epoch = referenceTime(match[2]);
  if (calendar !== 'proleptic_gregorian' && epoch < GREGORIAN_START) {
    throw new Error('Time references before 1582-10-15 require the proleptic_gregorian calendar in this viewer.');
  }
  const decoded = decodeNumeric(values, attributes, 'time');
  for (let i = 0; i < decoded.length; i++) {
    const time = epoch + decoded[i] * multiplier;
    if (!Number.isFinite(time) || Math.abs(time) > 8640000000000000) {
      throw new Error(`time: row ${i + 1} has a missing or invalid timestamp. Every track point needs a valid time.`);
    }
    if (calendar !== 'proleptic_gregorian' && time < GREGORIAN_START) {
      throw new Error('Dates before 1582-10-15 require the proleptic_gregorian calendar in this viewer.');
    }
    decoded[i] = time;
  }
  return decoded;
}

function identifier(value, name, row) {
  if (!['string', 'number', 'bigint'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(`${name}: invalid identifier at row ${row + 1}.`);
  }
  const text = String(value).replace(/\0/g, '').trim();
  if (!text) throw new Error(`${name}: missing identifier at row ${row + 1}.`);
  return text;
}

export function buildDataset(variables, onProgress = () => {}) {
  for (const name of REQUIRED) {
    if (!variables[name]) throw new Error(`Missing required variable "${name}". Expected storm, time, lon, and lat.`);
  }
  const n = variables.storm.values.length;
  if (!n) throw new Error('The file contains no track points.');
  for (const [name, variable] of Object.entries(variables)) {
    if (variable.values.length !== n) throw new Error(`${name}: expected ${n} rows, found ${variable.values.length}. All variables must share one point dimension.`);
  }

  const time = decodeTime(variables.time.values, variables.time.attributes);
  const lon = decodeNumeric(variables.lon.values, variables.lon.attributes, 'lon');
  const lat = decodeNumeric(variables.lat.values, variables.lat.attributes, 'lat');
  const wind = variables.wind ? decodeNumeric(variables.wind.values, variables.wind.attributes, 'wind') : new Float64Array(n).fill(NaN);
  const groups = new Map();
  let skippedPoints = 0;
  for (let i = 0; i < n; i++) {
    const id = identifier(variables.storm.values[i], 'storm', i);
    const realization = variables.realization ? identifier(variables.realization.values[i], 'realization', i) : '0';
    const key = JSON.stringify([realization, id]);
    if (!groups.has(key)) groups.set(key, {key, id, realization, rows: [], validCount: 0});
    const group = groups.get(key);
    group.rows.push(i);
    if (!Number.isFinite(lon[i]) || !Number.isFinite(lat[i]) || Math.abs(lat[i]) > 90) {
      lon[i] = NaN;
      lat[i] = NaN;
      skippedPoints++;
    } else {
      lon[i] = ((lon[i] + 180) % 360 + 360) % 360 - 180;
      group.validCount++;
    }
    if (i % 50000 === 0) onProgress(`Indexing track points (${i.toLocaleString()} / ${n.toLocaleString()})…`, 65 + i / n * 15);
  }

  const output = {
    tracks: [], lon: new Float64Array(n), lat: new Float64Array(n), time: new Float64Array(n),
    wind: new Float64Array(n), stateCodes: new Uint16Array(n), states: [''],
    windUnits: String(scalar(variables.wind?.attributes?.units) ?? '').trim(), warnings: []
  };
  const stateLookup = new Map([['', 0]]);
  const realizations = new Set(), basins = new Set();
  let offset = 0, groupIndex = 0, minYear = Infinity, maxYear = -Infinity;
  for (const group of groups.values()) {
    groupIndex++;
    if (!group.validCount) continue;
    group.rows.sort((a, b) => time[a] - time[b] || a - b);
    const first = group.rows[0], last = group.rows[group.rows.length - 1];
    const basin = group.id.match(/^[a-z]{2}(?=\d)/i)?.[0].toUpperCase() || 'Unknown';
    const year = new Date(time[first]).getUTCFullYear();
    const track = {
      key: group.key, id: group.id, realization: group.realization, basin, year,
      startTime: time[first], endTime: time[last], maxWind: NaN,
      offset, count: group.rows.length, validCount: group.validCount
    };
    for (const row of group.rows) {
      output.lon[offset] = lon[row];
      output.lat[offset] = lat[row];
      output.time[offset] = time[row];
      output.wind[offset] = Number.isFinite(wind[row]) ? wind[row] : NaN;
      if (Number.isFinite(wind[row]) && (!Number.isFinite(track.maxWind) || wind[row] > track.maxWind)) track.maxWind = wind[row];
      const state = String(variables.state?.values[row] ?? '').replace(/\0/g, '').trim();
      if (!stateLookup.has(state)) {
        if (output.states.length > 65535) throw new Error('The file contains more than 65,536 distinct state labels.');
        stateLookup.set(state, output.states.length);
        output.states.push(state);
      }
      output.stateCodes[offset] = stateLookup.get(state);
      offset++;
    }
    output.tracks.push(track);
    realizations.add(track.realization);
    basins.add(basin);
    minYear = Math.min(minYear, year);
    maxYear = Math.max(maxYear, year);
    if (groupIndex % 2000 === 0) onProgress(`Preparing ${groupIndex.toLocaleString()} tracks…`, 80 + groupIndex / groups.size * 19);
  }
  if (!output.tracks.length) throw new Error('The file contains no valid track positions. Check longitude and latitude values.');
  for (const name of ['lon', 'lat', 'time', 'wind', 'stateCodes']) output[name] = output[name].subarray(0, offset);
  if (skippedPoints) output.warnings.push(`${skippedPoints.toLocaleString()} invalid positions were omitted from the map; gaps are preserved in the track lines.`);
  if (!variables.wind) output.warnings.push('No wind variable is present.');
  else if (!output.windUnits) output.warnings.push('Wind units are not specified in this file. Values are shown without conversion.');
  output.stats = {
    inputPoints: n, pointCount: n - skippedPoints, trackCount: output.tracks.length, skippedPoints,
    minYear, maxYear, realizations: [...realizations].sort((a, b) => a.localeCompare(b, undefined, {numeric: true})),
    basins: [...basins].sort()
  };
  onProgress('Tracks ready.', 100);
  return output;
}
