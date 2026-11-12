import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import * as server from '../src/lib/google-analytics-server';
const eventId = '00000000-0000-4000-8000-000000000001';
const clientId = '00000000-0000-4000-8000-000000000002';
const wire = () => ({ event: 'page_view', route: 'campaign', eventId, clientId, sessionId: Math.floor(Date.now() / 1000), properties: {} });
const config = { measurementId: 'G-SYNTHETIC123', apiSecret: 'SYNTHETIC_SERVER_SECRET', siteOrigin: 'https://sqratch.example' };

test('server accepts only fixed event/route enums, UUIDs, recent anonymous session and closed validated properties', () => {
  const good = wire(); assert.ok(server.parseGoogleWireEvent(good));
  const changes = [
    { event: 'SYNTHETIC_SECRET_EVENT' }, { route: '/c/SYNTHETIC_TOKEN' }, { route: 'https://secret.example/' }, { route: '__proto__' },
    { eventId: 'SYNTHETIC_TOKEN' }, { clientId: 'test.user@example.com' }, { clientId: '00000000-0000-0000-0000-000000000000' },
    { sessionId: 0 }, { sessionId: good.sessionId + 1000 }, { sessionId: good.sessionId - 86401 }, { sessionId: 'SYNTHETIC_TOKEN' },
    { email: 'test.user@example.com' }, { properties: { page_location: 'https://secret.example/?token=SYNTHETIC' } },
    { properties: { items: [{ item_name: 'private' }] } }, { properties: { value: -1 } }, { properties: { value: Infinity } }, { properties: { currency: 'test.user@example.com' } },
    { properties: [] }, { properties: null },
  ];
  for (const change of changes) assert.equal(server.parseGoogleWireEvent({ ...good, ...change }), null, JSON.stringify(change));
  assert.ok(server.parseGoogleWireEvent({ ...good, properties: { value: 10, quantity: 2, currency: 'CAD', engagement_time_msec: 100 } }));
});

test('MP payload has anonymous IDs and static page metadata, excludes eventId, request IP, referrer and user data', () => {
  const parsed = server.parseGoogleWireEvent(wire()); assert.ok(parsed);
  const payload = server.googleMeasurementPayload(parsed);
  assert.equal(payload.client_id, clientId); assert.equal(payload.events[0].name, 'page_view');
  assert.equal(payload.events[0].params.page_path, '/c/[campaignSlug]'); assert.equal(payload.events[0].params.page_title, 'SQRATCH');
  assert.deepEqual(payload.consent, { ad_user_data: 'DENIED', ad_personalization: 'DENIED' });
  assert.doesNotMatch(JSON.stringify(payload), /page_referrer|ip_override|user_id|user_location|device|eventId|user_agent|SYNTHETIC|api_secret/);
});

test('sender performs one bounded server-only POST with canonical origin, no forwarded request headers and no retry', async () => {
  const parsed = server.parseGoogleWireEvent(wire()); assert.ok(parsed);
  const requests: { target: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (target, init) => { requests.push({ target: String(target), init }); return new Response(null, { status: 204 }); };
  assert.equal(await server.sendGoogleMeasurement(parsed, config, fetcher), true); assert.equal(requests.length, 1);
  const endpoint = new URL(requests[0].target); assert.equal(endpoint.origin, 'https://www.google-analytics.com'); assert.equal(endpoint.pathname, '/mp/collect'); assert.equal(endpoint.searchParams.get('measurement_id'), config.measurementId); assert.equal(endpoint.searchParams.get('api_secret'), config.apiSecret);
  assert.equal(requests[0].init?.redirect, 'error'); assert.equal(requests[0].init?.cache, 'no-store'); assert.ok(requests[0].init?.signal);
  assert.deepEqual(requests[0].init?.headers, { 'Content-Type': 'application/json' });
  const payload = JSON.parse(String(requests[0].init?.body)); assert.equal(payload.events[0].params.page_location, 'https://sqratch.example/c/[campaignSlug]'); assert.doesNotMatch(String(requests[0].init?.body), /SYNTHETIC_SERVER_SECRET|cookie|authorization|referrer|user_agent|ip_override/);
  let failures = 0; assert.equal(await server.sendGoogleMeasurement(parsed, config, async () => { failures++; throw new Error('SYNTHETIC_PROVIDER_SECRET'); }), false); assert.equal(failures, 1);
  assert.equal(await server.sendGoogleMeasurement(parsed, config, async () => new Response(null, { status: 500 })), false);
});

test('invalid or missing server config fails closed without any provider request', async () => {
  const parsed = server.parseGoogleWireEvent(wire()); assert.ok(parsed); let calls = 0;
  for (const change of [{ measurementId: 'SYNTHETIC_INVALID_ID' }, { apiSecret: '' }, { siteOrigin: 'not-a-url' }, { siteOrigin: 'https://secret.example/path?token=SYNTHETIC' }, { siteOrigin: 'https://user:secret@example.com/' }, { siteOrigin: 'javascript:secret' }]) {
    assert.equal(await server.sendGoogleMeasurement(parsed, { ...config, ...change }, async () => { calls++; return new Response(); }), false);
  }
  assert.equal(calls, 0);
});

function routeHarness(options: { config?: boolean; deny?: string; requestUrl?: string } = {}) {
  const afterWork: (() => Promise<void>)[] = []; const sends: { event: unknown; config: unknown }[] = []; const rateKeys: string[] = []; const seen = new Map<string, number>();
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  runInNewContext(ts.transpileModule(readFileSync('src/app/api/analytics/google/route.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Response, Buffer, URL, process: { env: options.config === false ? {} : { GA4_MEASUREMENT_ID: config.measurementId, GA4_API_SECRET: config.apiSecret, GA4_SITE_ORIGIN: config.siteOrigin } },
    require(name: string) {
      if (name === 'node:crypto') return crypto;
      if (name === 'next/server') return { after: (callback: () => Promise<void>) => afterWork.push(callback) };
      if (name === '@/lib/google-analytics-server') return { ...server, sendGoogleMeasurement: async (event: unknown, suppliedConfig: unknown) => { sends.push({ event, config: suppliedConfig }); return true; } };
      if (name === '@/lib/rate-limit') return { getRequestIp: () => 'SYNTHETIC_REQUEST_IP', rateLimit: (key: string, limit: number) => { rateKeys.push(key); const count = (seen.get(key) ?? 0) + 1; seen.set(key, count); return { success: !(options.deny && key.startsWith(options.deny)) && count <= limit }; } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const post = (body: unknown = wire(), headers: Record<string, string> = {}, raw = false) => {
    assert.ok(exports.POST); return exports.POST(new Request(options.requestUrl ?? 'https://sqratch.example/api/analytics/google', { method: 'POST', headers: { origin: 'https://sqratch.example', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: raw ? String(body) : JSON.stringify(body) }));
  };
  return { afterWork, sends, rateKeys, post };
}

test('actual route queues one valid event after response and deduplicates a repeated event without URL/IP forwarding', async () => {
  const app = routeHarness(); const value = wire(); const response = await app.post(value, { cookie: 'SYNTHETIC_AUTH_COOKIE', referer: 'https://sqratch.example/login?token=SYNTHETIC_REFERRER' });
  assert.equal(response.status, 204); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(app.sends.length, 0); assert.equal(app.afterWork.length, 1);
  assert.equal((await app.post(value)).status, 204); assert.equal(app.afterWork.length, 1); await app.afterWork[0](); assert.equal(app.sends.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(app.sends[0])), { event: value, config });
  assert.doesNotMatch(JSON.stringify(app.rateKeys), /SYNTHETIC_REQUEST_IP/); assert.doesNotMatch(JSON.stringify(app.sends), /SYNTHETIC_AUTH_COOKIE|SYNTHETIC_REFERRER|SYNTHETIC_REQUEST_IP/);
});

test('actual route rejects foreign origin/site, oversized or non-JSON body and unknown URL/PII fields before scheduling', async () => {
  const app = routeHarness();
  const rejectedHeaders: Record<string, string>[] = [{ origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: '' }];
  for (const headers of rejectedHeaders) assert.equal((await app.post(wire(), headers)).status, 403);
  assert.equal((await app.post(wire(), { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await app.post(wire(), { 'content-length': '4097' })).status, 400);
  assert.equal((await app.post('x'.repeat(4097), {}, true)).status, 413);
  assert.equal((await app.post('{', {}, true)).status, 400);
  for (const extra of [{ url: 'https://secret.example/?token=SYNTHETIC' }, { page_location: 'secret' }, { email: 'test.user@example.com' }, { properties: { email: 'test.user@example.com' } }]) assert.equal((await app.post({ ...wire(), ...extra })).status, 400);
  assert.equal(app.afterWork.length, 0); assert.equal(app.sends.length, 0);
});

test('actual route honors DNT/GPC, disabled configuration and both abuse limits without provider calls', async () => {
  const app = routeHarness(); for (const header of ['dnt', 'sec-gpc']) assert.equal((await app.post(wire(), { [header]: '1' })).status, 204); assert.equal(app.afterWork.length, 0);
  const missing = routeHarness({ config: false }); assert.equal((await missing.post()).status, 204); assert.equal(missing.afterWork.length, 0);
  for (const deny of ['ga-ip:', 'ga-client:']) { const limited = routeHarness({ deny }); assert.equal((await limited.post()).status, 429); assert.equal(limited.afterWork.length, 0); }
});

test('configured canonical origin accepts a proxied internal Next URL without trusting forwarded host', async () => {
  const app = routeHarness({ requestUrl: 'http://localhost:3000/api/analytics/google' });
  assert.equal((await app.post()).status, 204); assert.equal(app.afterWork.length, 1);
  assert.equal((await app.post(wire(), { origin: 'https://foreign.example', 'x-forwarded-host': 'foreign.example' })).status, 403);
});
