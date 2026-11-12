/** Deny by default. New public routes require an explicit review here. */
export function analyticsPath(input: string): string | null {
  try {
    const url = new URL(input, "https://analytics.invalid");
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const path = decodeURIComponent(url.pathname).replace(/\/$/, '') || '/';
    if (['/', '/about', '/support', '/privacy', '/terms'].includes(path)) return path;
    // Never copy dynamic segments (including emails, QR payloads or tokens).
    if (/^\/c\/[^/]+$/.test(path)) return '/c/[campaignSlug]';
    if (/^\/q\/[^/]+$/.test(path)) return '/q/[qrCodeData]';
    if (/^\/redeemQR\/[^/]+\/[^/]+$/.test(path)) return '/redeemQR/[campaignID]/[qrcodeID]';
    if (/^\/x\/[^/]+$/.test(path)) return '/x/[experienceSlug]';
    if (/^\/x\/[^/]+\/(shop|posts|learn|qa)$/.test(path)) return `/x/[experienceSlug]/${path.split('/')[3]}`;
    if (/^\/x\/[^/]+\/courses\/[^/]+$/.test(path)) return '/x/[experienceSlug]/courses/[courseSlug]';
    if (/^\/x\/[^/]+\/lessons\/[^/]+$/.test(path)) return '/x/[experienceSlug]/lessons/[lessonId]';
  } catch { /* Malformed encoding/URL is never telemetry. */ }
  return null;
}

export function safeAnalyticsUrl(input: string): string | null {
  const path = analyticsPath(input);
  return path ? new URL(input, 'https://analytics.invalid').origin + path : null;
}

/** Check live location too: SDK callbacks can outlive the route that mounted them. */
export function filterTelemetry<T extends { type: string; url: string; route?: string }>(event: T, currentUrl: string, referrer = ''): T | null {
  const url = safeAnalyticsUrl(event.url);
  if (!url || !analyticsPath(currentUrl) || event.type === 'event') return null;
  if (new URL(url).origin !== new URL(currentUrl, 'https://analytics.invalid').origin) return null;
  if (referrer) {
    try { const ref = new URL(referrer); if (ref.search || ref.hash || !analyticsPath(referrer)) return null; } catch { return null; }
  }
  // Closed callback result: no arbitrary custom data or raw route values.
  return { type: event.type, url, ...(event.type === 'vital' ? { route: analyticsPath(event.url)! } : {}) } as T;
}

const events = new Set(['page_view', 'qr_scan', 'campaign_view', 'campaign_click', 'product_click', 'select_item', 'view_item', 'purchase', 'generate_lead']);
export function safeGoogleEvent(event: string, params: Record<string, unknown> = {}, currentUrl: string) {
  const page_location = safeAnalyticsUrl(currentUrl);
  if (!page_location || !events.has(event)) return null;
  const properties: Record<string, unknown> = { page_location, page_path: analyticsPath(currentUrl), page_title: 'SQRATCH', page_referrer: '' };
  for (const key of ['value', 'quantity', 'engagement_time_msec']) {
    if (typeof params[key] === 'number' && Number.isFinite(params[key]) && params[key] >= 0 && params[key] <= 1e12) properties[key] = params[key];
  }
  if (typeof params.currency === 'string' && /^[A-Z]{3}$/.test(params.currency)) properties.currency = params.currency;
  return { event, properties };
}

/** Hosted Speed Insights preserves DOM selectors outside beforeSend. Only
 * reviewed static pages may collect vitals; user-authored public content may not. */
export function filterSpeedTelemetry<T extends { type: string; url: string; route?: string }>(event: T, currentUrl: string, referrer = ''): T | null {
  const staticPaths = ['/', '/about', '/support', '/privacy', '/terms'];
  if (!staticPaths.includes(analyticsPath(currentUrl) ?? '') || !staticPaths.includes(analyticsPath(event.url) ?? '')) return null;
  return filterTelemetry(event, currentUrl, referrer);
}

/** Wire identifiers are fixed enums, never browser-supplied paths or URLs. */
export const GOOGLE_ROUTES = {
  home: '/', about: '/about', support: '/support', privacy: '/privacy', terms: '/terms',
  campaign: '/c/[campaignSlug]', qr: '/q/[qrCodeData]', redeem: '/redeemQR/[campaignID]/[qrcodeID]',
  experience: '/x/[experienceSlug]', shop: '/x/[experienceSlug]/shop', posts: '/x/[experienceSlug]/posts',
  learn: '/x/[experienceSlug]/learn', qa: '/x/[experienceSlug]/qa',
  course: '/x/[experienceSlug]/courses/[courseSlug]', lesson: '/x/[experienceSlug]/lessons/[lessonId]',
} as const;
export function googleRouteKey(url: string) {
  const path = analyticsPath(url);
  return Object.entries(GOOGLE_ROUTES).find(([, template]) => template === path)?.[0] ?? null;
}
export const GOOGLE_EVENTS = ['page_view', 'qr_scan', 'campaign_view', 'campaign_click', 'product_click', 'select_item', 'view_item', 'purchase', 'generate_lead'] as const;
