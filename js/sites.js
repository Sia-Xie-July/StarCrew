// Curated dark-sky sites around Boston and a rough drive-time estimate.
// Bortle values are approximate readings from public light-pollution maps
// (lightpollutionmap.info, VIIRS 2024 layer). Always check park hours before going.

// Default start point: MIT / Kendall Square, Cambridge MA
export const DEFAULT_START = { label: "Cambridge, MA", lat: 42.3601, lon: -71.0942 };

// Rough road model: straight-line distance x detour factor at an average speed.
const ROAD_FACTOR = 1.3;
const AVG_SPEED_KMH = 70;
const OVERHEAD_MIN = 10;

const site = (id, name, town, lat, lon, bortle, note) => ({ id, name, town, lat, lon, bortle, note });

export const SITES = [
  site("blue-hills", "Great Blue Hill", "Milton, MA", 42.2119, -71.1145, 6,
    "Closest option; city glow to the north. Reservation closes at dusk, so check access."),
  site("wachusett", "Wachusett Mountain State Park", "Princeton, MA", 42.4887, -71.8868, 4,
    "Summit road gated at night in some seasons; lower lot is a common meetup."),
  site("douglas", "Douglas State Forest", "Douglas, MA", 42.0480, -71.7690, 4,
    "Quiet lot near Wallum Lake; low horizon to the south."),
  site("myles-standish", "Myles Standish State Forest", "Carver, MA", 41.8390, -70.6936, 4,
    "Large forest, many pull-offs; mosquitoes in summer."),
  site("halibut-point", "Halibut Point State Park", "Rockport, MA", 42.6873, -70.6311, 5,
    "Ocean horizon to the north and east; parking lot hours apply."),
  site("nickerson", "Nickerson State Park", "Brewster, MA", 41.7759, -70.0300, 4,
    "Campground on Cape Cod; good for overnight trips."),
  site("coast-guard-beach", "Cape Cod National Seashore (Coast Guard Beach)", "Eastham, MA",
    41.8576, -69.9493, 3, "Dark ocean horizon to the east; beach lot rules apply."),
  site("harvard-forest", "Harvard Forest", "Petersham, MA", 42.5313, -72.1898, 3,
    "Very dark central-MA sky; open fields along Route 32."),
  site("quabbin", "Quabbin Reservoir (Winsor Dam)", "Belchertown, MA", 42.2861, -72.3374, 3,
    "Wide-open dam with a big southern sky; gates close at night, so check DCR hours."),
  site("pack-monadnock", "Miller State Park (Pack Monadnock)", "Peterborough, NH", 42.8619, -71.8786, 4,
    "Summit road; 360-degree view when open."),
  site("jaffrey", "Monadnock State Park area", "Jaffrey, NH", 42.8495, -72.1150, 3,
    "Rural southern-NH sky; use the state park lot."),
  site("bear-brook", "Bear Brook State Park", "Allenstown, NH", 43.1445, -71.3684, 4,
    "Home of the NH Astronomical Society observatory field."),
];

export const SITES_BY_ID = Object.fromEntries(SITES.map((s) => [s.id, s]));

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

export function estimateDriveMinutes(startLat, startLon, s) {
  const km = haversineKm(startLat, startLon, s.lat, s.lon) * ROAD_FACTOR;
  return Math.round((km / AVG_SPEED_KMH) * 60 + OVERHEAD_MIN);
}

export function sitesWithin(startLat, startLon, maxDriveMinutes) {
  return SITES
    .map((s) => ({ ...s, drive_minutes_est: estimateDriveMinutes(startLat, startLon, s) }))
    .filter((s) => s.drive_minutes_est <= maxDriveMinutes)
    .sort((a, b) => a.drive_minutes_est - b.drive_minutes_est);
}
