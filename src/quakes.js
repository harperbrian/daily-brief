/**
 * Earthquakes near the people in config/people.json. USGS publishes a GeoJSON
 * feed with magnitude, coordinates and a PAGER impact estimate; the RSS feed
 * the daily brief uses has none of that, so this is fetched directly.
 *
 * The bar is impact, not "felt": a M4.5 directly under a big city rattles dishes
 * and makes the news; a M5.5 within 100 miles, or anything USGS itself rates
 * yellow or worse for casualties/damage, is when you text someone.
 */

export const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';

const EARTH_KM = 6371;

/** Great-circle distance in km. */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

const PAGER_IMPACT = new Set(['yellow', 'orange', 'red']);

/**
 * True when a quake is close enough and big enough to matter to someone at
 * (lat, lng). Pure so it can be tested without a network.
 */
export function quakeMattersTo(quake, place) {
  const km = distanceKm(quake.lat, quake.lng, place.lat, place.lng);
  const mag = quake.mag ?? 0;
  if (mag >= 5.5 && km <= 160) return { km, reason: `M${mag.toFixed(1)} within 100 mi` };
  if (mag >= 5.0 && km <= 50) return { km, reason: `M${mag.toFixed(1)} within 30 mi` };
  if (PAGER_IMPACT.has(quake.alert) && km <= 300) return { km, reason: `USGS ${quake.alert} impact alert` };
  return null;
}

/** GeoJSON feature → the small shape the rest of this module uses. */
export function parseFeature(f) {
  const [lng, lat] = f.geometry?.coordinates ?? [];
  const p = f.properties ?? {};
  return { id: f.id, mag: p.mag, place: p.place, time: p.time, alert: p.alert, tsunami: p.tsunami === 1, url: p.url, lat, lng };
}

/**
 * Synthesizes alert candidates for quakes near any people place. Returns []
 * on any failure — a USGS outage must never break the hourly run.
 */
export async function nearbyQuakes(places, { lookbackHours = 2, log, fetchImpl = fetch } = {}) {
  let features;
  try {
    const res = await fetchImpl(USGS_URL, { headers: { 'User-Agent': 'daily-brief (github.com/harperbrian/daily-brief)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ({ features } = await res.json());
  } catch (err) {
    log?.(`USGS fetch failed: ${err.message}`, 'warn');
    return [];
  }
  const cutoff = Date.now() - lookbackHours * 3600e3;
  const out = [];
  for (const f of features ?? []) {
    const q = parseFeature(f);
    if (!(q.time >= cutoff)) continue;
    for (const place of places) {
      const hit = quakeMattersTo(q, place);
      if (!hit) continue;
      const miles = Math.round(hit.km * 0.621);
      out.push({
        title: `M${q.mag.toFixed(1)} earthquake ${miles} mi from ${place.place}${q.tsunami ? ' — tsunami flag set' : ''}`,
        url: q.url,
        published_at: q.time,
        snippet: `USGS: ${q.place}. ${hit.reason}. People there: ${place.people}.`,
        source: 'USGS',
        feed_id: 'usgs_geojson',
        track: 'people',
        place: place.id,
        tier: 1,
        lean: 'primary',
        source_class: 'primary',
        alert: true,
        quake: true,
      });
    }
  }
  return out;
}
