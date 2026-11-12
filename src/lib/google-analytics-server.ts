import { GOOGLE_EVENTS, GOOGLE_ROUTES } from './analytics-policy';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every((key) => allowed.includes(key)); }
export function parseGoogleWireEvent(value: unknown, now = Date.now()) {
  if (!record(value) || !keys(value, ['event', 'route', 'eventId', 'clientId', 'sessionId', 'properties'])) return null;
  if (typeof value.event !== 'string' || !(GOOGLE_EVENTS as readonly string[]).includes(value.event)) return null;
  if (typeof value.route !== 'string' || !Object.hasOwn(GOOGLE_ROUTES, value.route)) return null;
  if (typeof value.eventId !== 'string' || !uuid.test(value.eventId) || typeof value.clientId !== 'string' || !uuid.test(value.clientId)) return null;
  if (!Number.isSafeInteger(value.sessionId) || Number(value.sessionId) < Math.floor(now / 1000) - 86400 || Number(value.sessionId) > Math.floor(now / 1000) + 60) return null;
  if (!record(value.properties) || !keys(value.properties, ['value', 'quantity', 'engagement_time_msec', 'currency'])) return null;
  const properties: Record<string, number | string> = {};
  for (const [key, entry] of Object.entries(value.properties)) {
    if (key === 'currency') { if (typeof entry !== 'string' || !/^[A-Z]{3}$/.test(entry)) return null; }
    else if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 1e12) return null;
    properties[key] = entry;
  }
  return { event: value.event, route: value.route as keyof typeof GOOGLE_ROUTES, clientId: value.clientId, sessionId: Number(value.sessionId), eventId: value.eventId, properties };
}
export function googleMeasurementPayload(event: NonNullable<ReturnType<typeof parseGoogleWireEvent>>) {
  return { client_id: event.clientId, consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' }, events: [{ name: event.event, params: { ...event.properties, session_id: event.sessionId, engagement_time_msec: event.properties.engagement_time_msec ?? 1, page_path: GOOGLE_ROUTES[event.route], page_title: 'SQRATCH' } }] };
}
export async function sendGoogleMeasurement(event: NonNullable<ReturnType<typeof parseGoogleWireEvent>>, config: { measurementId: string; apiSecret: string; siteOrigin: string }, fetcher: typeof fetch = fetch) {
  if (!/^G-[A-Z0-9]+$/.test(config.measurementId) || !config.apiSecret) return false;
  let origin: URL;
  try { origin = new URL(config.siteOrigin); } catch { return false; }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
  const payload = googleMeasurementPayload(event);
  Object.assign(payload.events[0].params, { page_location: origin.origin + GOOGLE_ROUTES[event.route] });
  const endpoint = new URL('https://www.google-analytics.com/mp/collect');
  endpoint.searchParams.set('measurement_id', config.measurementId); endpoint.searchParams.set('api_secret', config.apiSecret);
  try {
    const result = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000), redirect: 'error', cache: 'no-store' });
    return result.ok; // Transport success only; not proof of GA reporting/acceptance.
  } catch { return false; } // Never log provider request URLs (they contain the API secret).
}
