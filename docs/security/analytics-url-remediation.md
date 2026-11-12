# Analytics URL and credential containment

Updated 2026-11-10: the failed iframe implementation is replaced by first-party GA4 Measurement Protocol delivery. Historical verification sections are retained; latest results and setup appear at the end.

## Cause, scope and threat model

The root layout previously installed Google's SDK globally in production whenever NEXT_PUBLIC_GA_ID was present. The manual page-view component forwarded every query parameter, full location (including fragments), and document title. gaEvent forwarded arbitrary names and properties. `send_page_view:false` did not disable enhanced measurement, automatic interactions or SDK history listeners. Vercel Web Analytics and Speed Insights were mounted everywhere without filtering. Tokens/PII in Commerce7 connect/link, nested login callbackUrl, verification email, recovery/OAuth/account paths could therefore enter third-party telemetry. Source establishes possible exposure, not actual provider receipt.

The audit found only GA, Vercel Web Analytics and Speed Insights as third-party analytics integrations. First-party QR scans, campaign/commerce click attribution and database analytics remain unchanged. Commerce7 scripts, verification against /v1/account/user, role/tenant ownership, linking-token protocol, rewards/exclusive access, install/uninstall/order/refund pipelines and Shopify authorization semantics are unchanged.

## Architecture

A single deny-by-default public-route policy excludes all auth, commerce7, shopify, API, account, dashboard, checkout and unknown routes. Only reviewed public static routes and QR/campaign/experience/course/lesson templates are tracked. Queries/fragments are always discarded; dynamic identifiers are replaced with parameter names, including identifiers that happen to contain emails or opaque tokens. No UTM or arbitrary query allowlist exists.

The sandboxed Google SDK was removed after reproducible browser failures, including HTTP-frame and cookieless variants; the internal vendor cause remains unproven. The current transport is first-party: production clients POST only fixed route enum keys, approved numeric/currency fields and anonymous UUID/event/session IDs to `/api/analytics/google`. The server rejects unknown fields, URLs, invalid enums/IDs and oversized bodies, then independently constructs the official GA4 Measurement Protocol payload. Page location uses a configured server origin plus a server-owned route template; title is fixed and referrer is absent. No Google script executes in the application or an iframe.

The API enforces same-origin requests, a streaming 4 KiB limit, existing per-instance IP/client rate limits, and bounded best-effort event-ID deduplication. Next.js `after` schedules an HTTPS POST after response completion with a three-second timeout and redirect rejection. No provider URL/body/error is logged. No automatic retry can duplicate an uncertain send. Missing configuration returns 204 without provider work; this means suppressed analytics, not verified delivery.

The browser rechecks the live route at dispatch, deduplicates page views by local pathname (not normalized template), ignores query/fragment-only changes, and resets deduplication after entering a denied route. Anonymous client/session IDs stay in sessionStorage with a memory fallback, a 30-minute inactivity timeout and a 24-hour session ceiling; no user IDs or authentication cookies are forwarded. DNT, Global Privacy Control and an explicit `window.sqratchAnalyticsConsent=false` suppress client delivery; the server also honors DNT/GPC headers. There was no existing consent manager in source. A future manager must set/revoke this consent control before collection. API bodies cannot override consent or advertising settings. Referrer policy is no-referrer, and requests omit cookies.

MP is not full gtag.js feature parity: automatic scroll/click/form measurement, advertising signals, cross-device/returning-user identity and detailed browser/session attribution are absent. Approved names, normalized page paths, session ID and engagement time are included; GA reporting and dedicated property receipt still need validation. Business events such as purchase do not have full ecommerce item/transaction semantics in this deliberately small contract; first-party business attribution remains canonical.

Web Analytics 2.0.1 and Speed Insights 2.0.0 support beforeSend. The installed package code registers that callback before injecting its remote script. Both components mount only on allowed paths; persistent SDK callbacks check both event URL and current location at send time, reject sensitive/referrer-bearing events, enforce same origin, and return a sanitized URL shape. Browser verification subsequently established that the hosted Speed Insights script preserves metric route and DOM-selector attribution outside beforeSend; the callback does not redact those fields. Speed Insights therefore now permits only reviewed static public pages and rejects dynamic-content metrics at send time. Web Analytics still tracks reviewed dynamic route templates. See analytics-browser-verification.md for browser evidence and limits. Arbitrary Vercel custom events are rejected (there are no current callers). Google business event names are allowlisted; currently the generic gaEvent helper has no application callers. New names/properties require explicit policy review.

The global Referrer-Policy is tightened to no-referrer. Commerce7's existing exact CSP/frame-ancestors and no-store rules are preserved. Four raw-error diagnostic sinks (Commerce7 settings sync and Shopify OAuth start, embedded exchange, currency lookup) now log fixed outcomes rather than exception/provider messages.

No migrations, shared database access, live provider calls, dependency upgrades, production settings changes, commits or deployments are part of this change.

## Changed files

- src/lib/analytics-policy.ts — route templates, URL/event redaction and send-time checks.
- src/lib/googleAnalytics.ts — guarded custom-event bridge.
- src/components/GoogleAnalytics.tsx — isolated SDK bootstrap and lifecycle.
- src/components/PrivacyAnalytics.tsx — both supported Vercel beforeSend filters.
- src/app/layout.tsx — remove global Google scripts; mount privacy-aware components.
- next.config.ts — global no-referrer, unchanged Commerce7 CSP/cache semantics.
- src/app/api/commerce7/link/route.ts — fixed settings-sync log outcome.
- src/app/api/shopify/embedded/session/route.ts — fixed token-exchange log outcome.
- src/app/api/shopify/oauth/start/route.ts — fixed OAuth-start log outcome.
- src/app/api/shopify/installations/[installId]/route.ts — fixed currency log outcome.
- tests/analytics-privacy.test.ts — synthetic URL, bootstrap and component execution tests.
- tests/commerce7-extension-hardening.test.ts — permit only the reviewed global referrer tightening while preserving frame/cache checks.
- docs/security/analytics-url-remediation.md — this report.

Pre-existing favicon.ico and favicon_old.ico changes are unrelated and preserved.

## Validation and limits

**Final verification:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `git diff --check`, and the complete `npm run verify` passed. The final full suite reports **3,226 tests: 3,203 passed, 23 skipped, zero failures/cancellations**. Focused privacy + Commerce7 hardening: **26/26 passed**. Node v24.19.0 / npm 11.17.0 were used (no repository engine/version pin was found). Verify ran sequential Prisma validation/generation, typecheck, lint, tests and build with unreachable loopback database placeholders. No database was accessed. The first full run identified two outdated assertions forbidding global headers; they now explicitly permit only the reviewed global no-referrer policy and keep the Commerce7 frame/cache checks. Graphify was refreshed; optional SQL-parser and oversized-graph community-view warnings do not affect code verification. The audit result is reported separately below.

Eight new tests execute URL policy, GA document bootstrap, actual Google component and gaEvent under synthetic hooks/DOM, dispatch timing before cleanup, and resumed public navigation. They cover the supplied synthetic account/link/nested/email examples plus OAuth, recovery, private routes, malformed values, public events and referrers. They never contact Google/Vercel. Existing Commerce7 hardening tests retain script/auth/header assertions.

The original implementation run used VM tests only. A subsequent user-authorized Chrome run with intercepted SDKs and collection is documented in [browser verification](analytics-browser-verification.md). The VM tests prove application dispatch/redaction and sandbox construction, not the external SDK's current browser behavior. No staging deployment was available. Real Google collection delivery remains unproven; do not treat the local SDK tests as provider acceptance.

Analytics changes are intentional: no query/UTM reporting, raw path IDs, private-page telemetry, raw referrers/titles or arbitrary custom fields. Google client identity is anonymous and stable only within the current app document; reloads start a new identity. Cookie-based returning-user/session comparisons, engagement/frame-derived metrics, advertising attribution and enhanced measurement may differ. First-party business attribution remains canonical. Normal public page views and approved interactions are retained at the application dispatch boundary; verify live delivery before rollout. Browser extensions, separately configured tag managers, platform access logs and third-party script behavior outside the reviewed SDK hooks are separate surfaces. Code cannot delete old provider data.

## Current local/staging browser verification

Use a production build with unreachable loopback database placeholders and synthetic GA4 configuration. Deny all external browser egress through a process-scoped proxy, intercept Vercel SDK collection, and intercept the server's Google fetch with a temporary test-process preload. Never add a runtime test endpoint or provider-host override to production code.

1. Hard-load the four synthetic examples in tests/analytics-privacy.test.ts and signup/OAuth/account/unknown routes. Expect no `/api/analytics/google` POST and no Google SDK or iframe. Commerce7's required script may load; do not submit valid credentials or scan real QR codes.
2. Load `/about?token=SYNTHETIC_PUBLIC_QUERY#SYNTHETIC_FRAGMENT`. Capture the browser POST: only `event`, route enum `about`, UUID IDs, numeric session ID and approved properties may appear. No raw URL/query/hash/title/referrer/cookie may be in its payload or Referer header.
3. Capture the server fetch scheduled after API response. Destination must be the official HTTPS MP endpoint, with a synthetic secret only in the required query, and canonical configured-origin `/about` in the body. Never record a real query secret. Google HTTP 2xx is transport success only.
4. Use actual Next links between login, signup and public home, then Back/Forward. Expect no events on denied routes, one page view per genuine public navigation, query-only deduplication and public resumption. Test approved custom events and rejected raw/unknown fields through the real endpoint. Fully rendered campaign/QR pages require a synthetic staging dataset; don't mutate or use shared production QR records.
5. Verify `/favicon.ico` serves the optimized 10,557-byte ICO, 16/32/48 frames. Verify no-referrer globally and original Commerce7 frame/no-store headers remain. Valid provider-auth/replay/webhook/reward testing remains a separate authorized synthetic provider exercise.
6. With a dedicated test property configured securely, submit synthetic MP payloads to Google's validation endpoint, then verify actual collection in Realtime/DebugView. Validation-only calls do not enter reports and do not validate the secret. Record counts/event names only. No dedicated credentials or property access have been supplied for this task, so this final acceptance cannot be claimed.

## Historical investigation — read-only operator procedure

1. Identify deployment versions/dates and whether NEXT_PUBLIC_GA_ID was present at build time using secure configuration UI. Record only presence/property identifiers, never complete environment values. Vercel packages were unconditional; actual receipt depends on enabled product/deployment settings, script reachability, blockers and retention.
2. GA4 Admin → Data streams → selected web stream: inspect measurement ID, enhanced measurement page-history/site-search/form/outbound settings, data redaction and unwanted-referral settings without saving changes. Check whether any separately installed Google Tag Manager/custom tags exist.
3. In GA4 Explore or an already-authorized read-only reporting tool, inspect aggregate counts for sensitive path prefixes in Page location, Page path + query string, Page referrer and event parameters over the affected deployment period. Use path-only filters (commerce7/connect, commerce7/link, login, verify-email, signup, OAuth). Do not display/export raw matching URLs, drill into token values, take screenshots containing values or copy rows. If count-only analysis cannot be done safely, have the authorized analytics owner perform it privately and report counts/date ranges only. Absence can reflect retention, truncation, sampling or missing configuration and is not proof of no collection.
4. Vercel project → Analytics and Speed Insights: inspect enablement, affected deployments/date ranges, path filters, referrer breakdowns and available retention/export configuration without changes. Request aggregate sensitive-prefix counts only; do not download raw URLs/HARs or paste customer identifiers. Platform request/access logs are outside this browser analytics fix; review their redaction/retention separately with the authorized operator.
5. If actual receipt is established, record provider, date range, data categories and aggregate count only; follow the organization's incident-response policy with the security/privacy owner. Evaluate credential validity and provider retention/deletion procedures privately. Do not assume remediation removed historical data or prescribe indiscriminate rotation/notification based solely on source-level possibility.

No production analytics setting change is required for the code boundary. As defense in depth, the property owner should review (and separately authorize changes to) enhanced measurement and redaction settings; disable unneeded automatic form/site-search/outbound/history measurement. No settings were changed here.

## Dependency audit

`npm audit --omit=dev` reports six dependency findings: one critical (Next.js), one high (follow-redirects), four moderate (fast-uri, nodemailer, next-auth and its adapter). This audit exits nonzero. These existing dependency advisories are separate from the browser telemetry patch; no dependency upgrade or audit fix was applied. Prioritize a compatibility-tested patch review for the critical/high findings. Review advisory applicability rather than claiming this telemetry change resolves them.

References: [Vercel redaction](https://vercel.com/docs/analytics/redacting-sensitive-data), [Google configuration](https://developers.google.com/analytics/devguides/collection/ga4/reference/config), installed SDK declarations/initialization code. Critical Next.js advisory: [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw); follow-redirects: [GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8).

Suggested commit: `fix: isolate analytics and redact sensitive navigation telemetry`.


## Browser-driven follow-up validation

The user subsequently authorized browser/computer testing, including read-only production checks while preserving users and QR data. The browser-discovered Speed Insights limitation was fixed with a static-page-only send-time gate and a new automated regression. Latest automated full suite: **3,227 tests, 3,204 passed, 23 skipped, zero failures/cancellations**. Nine privacy tests pass; typecheck, lint and diff checks pass. See the separate browser report for exact browser outcomes, local production rebuild and SDK/proxy limitations. Browser testing now demonstrates a Google delivery failure: a matched direct-page control emits collection while the opaque frame does not. HTTP frame navigation and denied-storage consent mode also failed to restore it. Google delivery is an unresolved rollout blocker, rather than merely unverified. No production data was mutated or deployment performed.


## Measurement Protocol completion — 2026-11-10

The iframe approach above is superseded. Configure **server-only** GA4_MEASUREMENT_ID, GA4_API_SECRET and GA4_SITE_ORIGIN for a dedicated test stream first. No production configuration was changed. NEXT_PUBLIC_GA_ID is no longer read and can be retired separately. Use Google's `/debug/mp/collect` with `validation_behavior=ENFORCE_RECOMMENDATIONS` to validate synthetic payload structure; that endpoint neither authenticates the secret nor records reports. Then verify synthetic events in the dedicated property's Realtime/DebugView. A collection HTTP 2xx or mock capture alone is not proof of provider receipt. No dedicated property credentials or authorized Realtime access were supplied; provider acceptance remains a merge blocker under the user's criteria.

Favicon: the user's new purple SQ/QR-style design was preserved. The active ICO now retains the original 16/32/48-pixel PNG frames byte-for-byte, dropping oversized frames: 129,987 → 10,557 bytes. favicon_old.ico remains unmodified and untracked as explicitly requested. It is the 4,286-byte prior Git favicon. Keep the optimized favicon logically separate from the analytics commit; do not include/delete the backup.

Operational limits: anonymous event validation proves only that a route enum is approved, not that an actual visitor viewed it; this is telemetry, never commerce evidence. Rate limits and replay suppression are per process, bounded to the existing limiter cache, and reset with cold starts. They are not a distributed exactly-once guarantee. Google requires the API secret in the outbound query string: application code does not log it, but the operator must ensure APM/fetch tracing, proxy logs and log drains redact `api_secret` before enabling real credentials. No production observability setting or secret was inspected/changed.

Additional completion files: src/lib/google-analytics-server.ts (closed parser and official MP sender), src/app/api/analytics/google/route.ts (same-origin validation/limits/deferred dispatch), tests/google-measurement.test.ts (mocked provider and real-route execution), .env.example and docs/env-vars.md (private configuration), tests/commerce7-exclusive-claims.test.ts (fixture-clock determinism only). No reward behavior was changed.


Final implementation tests (2026-11-10): 19 focused privacy/MP tests and 42 exclusive-claim tests passed. Full suite: 3,237 total, 3,214 passed, 23 skipped, zero failures/cancellations. The two previously time-sensitive exclusive-claim DTO tests now use the saga fixture clock; no production reward behavior was changed. Browser captures verify same-origin client POSTs and sanitized server MP payload construction with intercepted synthetic provider responses; dedicated Google validation/Realtime/DebugView is not verified. The active favicon was verified over HTTP at 10,557 bytes. Readiness remains **NOT READY TO MERGE** until the dedicated test stream is configured and actual provider collection is accepted. No shared DB writes, commits, pushes, merges or deployment occurred.

Final `npm run verify` exited 0: Prisma validation/generation, typecheck, lint, all tests and the production build passed. `git diff --check` passed and Graphify was updated. Build/test database URLs were unreachable loopback placeholders; no migration command ran.
