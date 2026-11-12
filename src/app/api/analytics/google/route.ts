import { after } from 'next/server';
import { createHash } from 'node:crypto';
import { getRequestIp, rateLimit } from '@/lib/rate-limit';
import { parseGoogleWireEvent, sendGoogleMeasurement } from '@/lib/google-analytics-server';
export const runtime = 'nodejs';
const reply = (status = 204) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
export async function POST(request: Request) {
  // Next may expose its internal localhost URL behind a reverse proxy. Compare
  // against the configured site origin, never untrusted forwarded host headers.
  let expectedOrigin = new URL(request.url).origin;
  if (process.env.GA4_SITE_ORIGIN) {
    try {
      const configured = new URL(process.env.GA4_SITE_ORIGIN);
      if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) return reply();
      expectedOrigin = configured.origin;
    } catch { return reply(); }
  }
  if (request.headers.get('origin') !== expectedOrigin || (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return reply(403);
  if (request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1') return reply();
  const ip = createHash('sha256').update(getRequestIp(request)).digest('hex');
  if (!rateLimit(`ga-ip:${ip}`, 60, 60000).success) return reply(429);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || Number(request.headers.get('content-length') ?? 0) > 4096) return reply(400);
  const reader = request.body?.getReader(); if (!reader) return reply(400);
  let size = 0; const parts: Uint8Array[] = [];
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4096) { await reader.cancel(); return reply(413); } parts.push(next.value); }
    const event = parseGoogleWireEvent(JSON.parse(Buffer.concat(parts).toString('utf8')));
    if (!event) return reply(400);
    const measurementId = process.env.GA4_MEASUREMENT_ID; const apiSecret = process.env.GA4_API_SECRET; const siteOrigin = process.env.GA4_SITE_ORIGIN;
    if (!measurementId || !apiSecret || !siteOrigin) return reply();
    if (!rateLimit(`ga-client:${event.clientId}`, 30, 60000).success) return reply(429);
    if (!rateLimit(`ga-event:${event.clientId}:${event.eventId}`, 1, 600000).success) return reply();
    after(async () => { try { await sendGoogleMeasurement(event, { measurementId, apiSecret, siteOrigin }); } catch { /* Invalid configuration fails closed, without secrets in logs. */ } });
    return reply();
  } catch { return reply(400); }
}
