export function unwrapLongitude(longitude, previousLongitude = null) {
  let lon = ((longitude + 180) % 360 + 360) % 360 - 180;
  if (Number.isFinite(previousLongitude)) {
    const delta = lon - previousLongitude;
    if (delta > 180) lon -= 360 * Math.ceil((delta - 180) / 360);
    if (delta < -180) lon += 360 * Math.ceil((-delta - 180) / 360);
  }
  return lon;
}

export function trackSegments(dataset, track) {
  const segments = [];
  let segment = [];
  for (let i = track.offset; i < track.offset + track.count; i += 1) {
    const lat = dataset.lat[i];
    let lon = dataset.lon[i];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      if (segment.length) segments.push(segment);
      segment = [];
      continue;
    }
    lon = unwrapLongitude(lon, segment.length ? segment[segment.length - 1][0] : null);
    segment.push([lon, lat]);
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function yearBound(value, fallback) {
  if (value === '' || value == null) return fallback;
  const year = Number(value);
  return Number.isFinite(year) ? year : fallback;
}

function isAll(value) {
  return value == null || value === '' || String(value).toLowerCase() === 'all';
}

export function filterTracks(tracks, { query = '', basin, realization, startYear, endYear } = {}) {
  const tokens = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const bounds = [yearBound(startYear, -Infinity), yearBound(endYear, Infinity)].sort((a, b) => a - b);
  const selectedBasin = isAll(basin) ? null : String(basin).toLowerCase();
  const selectedRealization = isAll(realization) ? null : String(realization);
  return tracks.filter(track => {
    if (selectedBasin !== null && String(track.basin).toLowerCase() !== selectedBasin) return false;
    if (selectedRealization !== null && String(track.realization) !== selectedRealization) return false;
    if (track.year < bounds[0] || track.year > bounds[1]) return false;
    const id = String(track.id).toLowerCase();
    const year = String(track.year);
    return tokens.every(token => id.includes(token) || year.includes(token));
  });
}
