import { GOOGLE_EVENTS, googleRouteKey } from './analytics-policy';
export type GoogleWireEvent = { event: string; route: string; eventId: string; clientId: string; sessionId: number; properties: Record<string, number | string> };
let identity: { clientId: string; sessionId: number; touched: number } | undefined;
let lastPage: string | null = null;
export function resetGooglePage() { lastPage = null; }
function identifiers() {
  const now = Date.now();
  if (!identity) {
    try { const stored = JSON.parse(sessionStorage.getItem('sqratch:anonymous-analytics') ?? 'null'); if (stored && /^[0-9a-f-]{36}$/.test(stored.clientId) && Number.isSafeInteger(stored.sessionId) && typeof stored.touched === 'number' && stored.touched <= now) identity = stored; } catch {}
  }
  if (!identity) identity = { clientId: crypto.randomUUID(), sessionId: Math.floor(now / 1000), touched: now };
  if (now - identity.touched > 30 * 60 * 1000 || now / 1000 - identity.sessionId > 86400) identity.sessionId = Math.floor(now / 1000);
  identity.touched = now;
  try { sessionStorage.setItem('sqratch:anonymous-analytics', JSON.stringify(identity)); } catch {}
  return identity;
}
declare global { interface Window { sqratchAnalyticsConsent?: boolean; } }
export function gaEvent(event: string, params: Record<string, unknown> = {}) {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'production') return;
  if (window.sqratchAnalyticsConsent === false || navigator.doNotTrack === '1' || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
  const route = googleRouteKey(window.location.href);
  if (!route || !(GOOGLE_EVENTS as readonly string[]).includes(event)) return;
  if (event === 'page_view' && lastPage === window.location.pathname) return;
  const properties: GoogleWireEvent['properties'] = {};
  for (const key of ['value', 'quantity', 'engagement_time_msec']) if (typeof params[key] === 'number' && Number.isFinite(params[key]) && params[key] >= 0 && params[key] <= 1e12) properties[key] = params[key];
  if (typeof params.currency === 'string' && /^[A-Z]{3}$/.test(params.currency)) properties.currency = params.currency;
  // No scheduling queue: validate live route immediately before dispatch.
  const { clientId, sessionId } = identifiers();
  const payload: GoogleWireEvent = { event, route, properties, clientId, sessionId, eventId: crypto.randomUUID() };
  if (googleRouteKey(window.location.href) !== route) return;
  if (event === 'page_view') lastPage = window.location.pathname;
  void fetch('/api/analytics/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true }).catch(() => { /* Analytics never blocks the app or retries ambiguous delivery. */ });
}
