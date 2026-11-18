# SQRATCH improvement backlog

This is the remaining implementation backlog. Original review evidence is historical; check the current source before applying any proposed change. Phase and finding identifiers are stable.

## 1. Current baseline

P00–P11, P14, P20, P22, P23, P25, P26, P28, P36 and P38 are shipped and deployed (disposable database tests, QR history safeguards, publication enforcement, atomic approvals, administrator protection, safer media persistence, brand-context preconditions, community display-name privacy, anonymous-transfer, QR batch archive, creator dashboard reliability, honest analytics names, password recovery, customer home, QR inventory search, commerce connection overview and order-date reporting). The P20 migration (`20261116120000_add_password_reset_token`) was applied to production by the owner. Their contracts live in `docs/points-ledger.md`, `docs/prisma-migrations.md`, `docs/agent-context.md` and `docs/env-vars.md`.

Implemented on branch `claude/remaining-correctness-ux-analytics` and awaiting review and deployment: **P12** (stop new QR redemptions, separate from archiving and deletion), **P13** (staged lesson-video ownership and claim-based cleanup), **P21** (atomic UTC-day Q&A limit), the Shopify reward-code collision retry fix, **P24** (refreshable approval status), **P27** (attached versus discoverable experiences), **P29** (rewards workspace: provider tabs, claim paging, catalog search), **P30** (all connections and full memberships in admin), **P31** (shared confirmation dialog and unsaved-work protection), **P32** (URL-backed filters), **P35** (client-side sidebar navigation, dashboard loading and error boundaries, request-path forwarding), **P37** (immutable `completedAt`), **P39** (report scope, attribution captions and drilldown context), **P44** (opt-in shared rate-limit store and a credential sign-in throttle) and the small corrections (QR `NEW` filter excludes `INVALID`, stale sync attempts read "Did not finish", the deprecated `gross*`/`net*` analytics fields are removed). P45 was evaluated and not changed; P46 is done with one documented exception. Their specifications were removed from this backlog.

## 2. Outstanding issues

- **P1 — Migration rollout (this branch):** four additive migrations, none with a backfill, applied by the owner before deploying the release, after the preflight in `docs/prisma-migrations.md`: `20261117120000_add_qr_redemption_stop`, `20261117130000_add_staged_asset`, `20261117140000_add_lesson_progress_completed_at`, `20261117150000_add_rate_limit_counter` (only read when `RATE_LIMIT_STORE=postgres`). Verified only on disposable databases.
- **P1 — P13 follow-ups:** nothing schedules the asset sweeper (`docs/lesson-video-uploads.md`); run the shared-storage-path check first. Real isolated object-storage acceptance (missing-object status, response-loss, failure paths) has not been run. Deleting an experience or a creator account cascades to lessons without releasing their videos. QR and profile images still use best-effort cleanup.
- **P2 — P12 follow-ups:** a scan of a stopped code writes a `qr_scan_stopped` event, which (like any scan event) keeps an unused code from being deleted. D-04 (whether `Campaign.isActive` or `Brand.isActive` should affect visitors) is undecided; run the read-only count of `isActive = false` rows for `QRCode`, `QRCodeBatch` and `Campaign` before deciding. Stopped codes are labelled STOPPED in the brand inventory, CSV export, `api/qr/get-all-qrcodes`, `api/qr/check-qrcode` (`redemptionStopped`) and the admin dashboard stats (`stoppedCount`); the stored status values are unchanged.
- **P2 — P07 / F-08:** expected-brand headers remain optional for old tabs. After the compatibility release require them on all applicable brand mutations, keeping membership authorization and clear 409 conflicts.
- **P2 — P31/P32 gaps:** in-app links, reload, tab close, brand switching and "Edit another offer" all ask before discarding a dirty form; the browser Back button and programmatic `router.push` are not intercepted (the browser's own prompt covers reload and close). The dialogs have not had a screen-reader or keyboard pass. Analytics date filters seed from the URL as dates; the order explorer does not write the order-number search to the URL on purpose.
- **P3 — P29/P30 notes:** Commerce7 offers page 50 at a time (`offersCursor`); refreshing the panel returns to the first page. The admin membership expander loads on demand.
- **P2 — P44 residual:** only sign-in, sign-up, verification resend and password recovery use the shared store, and only when `RATE_LIMIT_STORE=postgres`; scans, analytics collection, waitlist and Shopify OAuth start stay per-instance. Sign-up, resend and recovery per-address limits trust the first `x-forwarded-for` entry (correct behind Vercel); the sign-in throttle prefers platform headers. An unverified account can reset its password but still cannot sign in until it verifies; middleware page gating accepts a pre-reset JWT until some request runs the session callback (data behind `getServerSession` is protected). Expired reset rows are removed only on the next request or reset for that user.
- **P3 — P37/P39 notes:** `completedAt` is never backfilled, so historical completions appear as "date not recorded". The learner "qualified in period" measure waits for P16–P18. The order explorer pages by receipt date while filtering by the chosen basis.
- **P3 — P45/P46:** P45 not done: `getServerSession` reads the user row once per call (session revocation depends on it) and some brand handlers resolve it twice; per-request memoization is not reliable in route handlers and the cost is negligible at the current scale, so no caching was added. P46: `npm audit --omit=dev` is clean. The only remaining advisory is the dev-only high-severity `xlsx` (no fixed release on the registry), imported solely by `scripts/import-legacy-printed-stickers.ts`; accepted as a documented exception until that script is retired or moved out of the application package.
- **P3 — Minor notes:** the QR pickers have no arrow-key navigation; a resend to a transferred account uses the default 10-minute code lifetime; a reset gives an account without a password one; the customer home caps experiences at 12 with no "view all" page; Commerce7 reconnect, settings and diagnostics render only for the brand's active connection; the legacy `syncProducts` (which stamps the connection) has no caller outside the persisted-sync fallback and can be removed with the `lastProductSyncAt` writers.
- **P3 — Schema discrepancies (read-only findings, nothing changed):** see `docs/prisma-migrations.md`, "Known schema discrepancies". Historical migrations cannot be replayed from an empty database (production was baselined); any correction needs a separate owner-reviewed migration.
- **P2 — D-02 accepted default:** sign-in also pays completion rewards an account has earned but not been paid (see `docs/points-ledger.md`); confirm the retroactive-payment consequence is acceptable.
- **P1 — D-16 / X-11:** decide reward funding and budget; creator self-award prevention does not stop collusion with another account.
- **P2 — Acceptance not yet run in a browser or against providers:** delivery through a real mail provider; claiming a reward from the shop UI with real provider offers; live Shopify/Commerce7 behavior including a product preview; real object storage (P13); screen-reader passes (seek control, QR pickers, recovery pages, dialogs); the brand-switch dirty prompt with a multi-brand user; the creator analytics completion cards; browser checks for P01/P02 (deletion of untouched batches, history blockers, legacy printed redirects) and P03/P04/P05/P08 (draft management, concurrent decisions, nameless displays). Existing PostgreSQL and mocked tests do not replace them.
- **P2 — X-16:** design global security headers with Shopify/Commerce7 embedding exemptions and a report-only CSP; separate work.
- **P2 — Past ledger drift:** the owner should run the read-only drift query in `docs/points-ledger.md`; any repair needs a separate data decision.
- **P2 — Deferred analytics:** C-07 captured payments and A-11 payment/refund activity need provider sandbox evidence and timestamps. A-17 conversion rates need a defined cohort, window and anonymous/account deduplication. A-22 product-health measures need instrumentation and baselines.
- **P2 — External verification:** GA4 live provider receipt, real storage behavior and deployed provider journeys need owner-authorized sandbox verification. Do not use production for automated QA.
- **P3 — O-06 / O-04 / F-08a:** defer worker throughput changes until P40 measurements; any future cache keys include brand, connection, filters and permission-sensitive state.
- Other previously noted but unverified issues (signup enumeration, comment length/author deletion, upload content sniffing) require separate verification; do not silently classify as resolved.

### Pending finding index

These rows retain review identifiers and proposed phase mappings. The mapped phase specifications below remain authoritative for intended scope; revalidate historical evidence.

| ID | Outstanding finding | Priority | Action | Phase |
|---|---|---|---|---|
| C-05 | Qualification must be a staged transition | P1 | Additive policy per lesson, default legacy | P16–P19 |
| C-07 | Correct labels first; captured-payment metrics later | P2 | Captured-payment metrics remain deferred pending provider evidence (labels shipped in P36) | H |
| C-09 | Fix behavior before reorganizing navigation | — | Navigation consolidation is last | P43 |
| F-04b | Record actor, time and reason; separate applicant and internal notes | P2 | Additive fields | P15 |
| F-05 | Client completion authorizes spendable rewards | P1 | Server-evaluated checkpoint policy, staged | P16–P19 |
| F-05a | Transition rules: preserve config, ledger, legacy labelling, no re-earning | P1 | Keep ledger keys; add policy enum | P16–P19 |
| F-07a | Explain blocked actions; record administrative changes | P2 | Error copy in P05; audit table in P15 | P05, P15 |
| F-08a | Brand scope in caches and request identities; clear on switch | P3 | Guard covers the risk today; keep as a rule for future caching | P07 |
| U-25 | Decision reason missing from the UI | P2 | Reason input, required on reject | P15 |
| N-02 | Creator: manage one experience | P3 | Experience context header | P34 |
| N-03 | Brand: operate one campaign | P3 | Campaign workspace nav | P33 |
| N-04 | Superadmin: actionable queue | P3 | State and history via P15, P40 | P15, P40 |
| N-05 | Consolidated navigation sets per role | P3 | Last | P43 |
| K-01 | Campaign flow as contextual guidance, not a wizard | P3 | Guidance strip | P33 |
| K-02 | Readiness tiers: blocker, warning, optional, provider limitation | P3 | Server-computed readiness | P33 |
| K-03 | Do not block content campaigns lacking commerce | — | Acceptance criterion | P33 |
| S-07 | Consolidate Contact and Support | P3 | Merge content, keep both URLs | P43 |
| S-08 | Consolidate overlapping admin routes after parity | P3 | Consolidate with redirects | P43 |
| A-07 | All matching orders are materialized | P3 | Measure first | P42 |
| A-11 | Payment and refund activity by date | P3 | Order-cohort reporting shipped in P38; activity-by-period reporting stays deferred until provider payment and refund timestamps are stored | H |
| A-16 | Place reporting beside decisions (ten surfaces) | P3 | Delivered incrementally | P33, P34, P40 |
| A-17 | Funnels only where evidence supports them | P3 | Stage counts only | P41 |
| ST-B | Stage B: shared correctness contracts | P1–P2 | Remaining: audit trail and qualification (four phases) | P15–P19 |
| ST-C | Stage C: daily workflow friction | P2–P3 | Remaining: campaign and experience workspaces | P33, P34 |
| ST-D | Stage D: correct analytics | P2–P3 | Remaining: operations visibility and funnel counts | P40, P41 |
| ST-E | Stage E: consolidate and optimize | P3 | Conditional phases | P42, P43 |
| I-04 | Versioned qualification and checkpoint records | P1 | Additive models | P16 |
| O-05 | Monitor worker backlog and oldest pending age | P3 | Read-only operations panel | P40 |
| O-09 | Scale risks are not measured outages | — | Baselines before optimizing | P42 |
| T-05 | Participation: client completion and seeking do not qualify | — | Phase tests | P16–P18 |
| T-15 | Performance comparison before and after | — | Baseline first | P42 |
| X-11 | Creator reward budgets remain undecided; colluding accounts can earn points | P1 | Preserve the owner-award exclusion and decide funding and limits | D-16 |
| X-16 | No global `nosniff`, frame or CSP headers | P2 | Separate hardening work | H |

## 3. Remaining implementation phases

### P15 — Admin audit trail and decision metadata

- **Priority and complexity:** P2, M.
- **Problem and evidence:** No audit model exists. Requests store `reviewedById` and one `reason` but no decision time, and applicant-facing text is not separated from internal notes (`prisma/schema.prisma:46-70`). The approvals page has no reason input although the API accepts one (`src/app/api/admin/approvals/brand/[requestId]/route.ts:56`).
- **Desired outcome:** Every approval decision and every access change writes an immutable audit row in the same transaction. Rejections require an applicant-facing reason. Internal notes are stored separately and never shown to applicants.
- **Scope:** migration adding `AdminAuditEvent` and, on both request models, `reviewedAt DateTime?` and `internalNote String?`; both approval routes; `src/lib/admin-user-mutations.ts`; approvals page; user-management page; a read-only `GET /api/admin/audit`.
- **Implementation requirements:**
  1. `AdminAuditEvent { id, actorId, action, targetType, targetId, before Json?, after Json?, reason?, createdAt }`, indexed on `(targetType, targetId, createdAt)`. No update or delete path exists in code.
  2. Write the event inside the P04 and P05 transactions. `before` and `after` hold only role, active state and request status. No emails or names beyond ids.
  3. Approval body accepts `reason` (applicant-facing) and `internalNote`. Reject requires a non-empty `reason` (400 otherwise).
  4. UI: decision dialog with both fields; history list per request and per user.
  5. Existing `reason` values are treated as applicant-facing. Existing rows have null `reviewedAt`; show "date not recorded". Do not copy `updatedAt` into it.
- **Dependencies:** P04, P05.
- **Compatibility and migration:** additive. Old clients that send only `reason` keep working for approvals.
- **Acceptance criteria:** each decision and access change produces exactly one audit row; a failed or conflicting request produces none; internal notes never appear in any non-admin response.
- **Testing:** L1 for route and serialization. L2: audit row count under the P04 and P05 races.
- **Regression risks:** approval email content; P24 status page reads `reason` only.
- **Decision blockers:** D-13. Proposed default: existing `reason` is applicant-facing; add `internalNote`.

### P16 — Qualification foundation

- **Priority and complexity:** P1, L. Schema and service only. No user-visible change.
- **Problem and evidence:** A client boolean authorizes spendable points (`src/app/api/progress/lesson/route.ts:290,417,446-455`). The browser sets it at 95% of duration, reachable by seeking (`src/components/experience/lesson-client.tsx:344-345,587-603`). Award calls are made directly from two places (the progress route and, after P09, the transfer service). No qualification model exists.
- **Desired outcome:** One service decides whether a user has earned a lesson or course reward, according to a per-lesson policy. Every lesson starts on the legacy policy, so behavior is identical after this phase.
- **Scope:** migration; new `src/lib/learning-awards.ts`; `src/app/api/progress/lesson/route.ts`; `src/lib/anonymous-transfer.ts`; `docs/points-ledger.md`.
- **Implementation requirements:**
  1. Schema, all additive:
     - enum `LessonParticipationPolicy { LEGACY_SELF_REPORTED, CHECKPOINT }` and `Lesson.participationPolicy` defaulting to `LEGACY_SELF_REPORTED`.
     - `LessonCheckpoint { id, lessonId, version, prompt, options Json, correctOptionIndex, status (DRAFT | PUBLISHED | RETIRED), publishedAt?, createdAt }` with `@@unique([lessonId, version])`.
     - `LessonQualification { id, userId, lessonId, checkpointId, checkpointVersion, qualifiedAt }` with `@@unique([userId, lessonId])`.
     - `LessonCheckpointAttempt { id, userId, checkpointId, isCorrect, createdAt }` indexed on `(userId, checkpointId, createdAt)`.
  2. `settleLessonAward({ userId, lessonId, db? })`: returns without awarding when the user owns the experience. For `LEGACY_SELF_REPORTED` it requires the user's `LessonProgress.isCompleted`. For `CHECKPOINT` it requires a `LessonQualification` row. It then calls `awardLessonCompletionPoints`. The ledger key stays `lesson-completion:{lessonId}`.
  3. `settleCourseAward({ userId, courseId, db? })`: returns without awarding when the user owns the experience. A legacy lesson is satisfied by `LessonProgress.isCompleted`. A checkpoint lesson is satisfied by a `LessonQualification` row, or by an existing `lesson-completion:{lessonId}` ledger row for that user. The second case matters: a learner who earned the lesson reward under the legacy policy has no qualification row after the lesson switches, and without this rule their course reward would be stranded. Otherwise identical to today's rule (all active lessons). Key stays `course-completion:{courseId}`.
  4. Replace the direct award calls in the progress route and in `settleOutstandingCompletionAwards` with these functions.
  5. Add a test that fails if any file outside `learning-awards.ts` and `src/lib/points.ts` calls `awardLessonCompletionPoints` or `awardCourseCompletionPoints`.
  6. `correctOptionIndex` must never be selected by any route outside the creator-owned authoring API. Add a test for that once P17 and P18 exist; note it here.
- **Dependencies:** P09.
- **Compatibility and migration:** additive; default policy preserves behavior; no backfill; no clawback. Rollback: revert code; columns and tables can remain unused.
- **Acceptance criteria:**
  - With every lesson on the legacy policy, awards for all existing flows are unchanged (same ledger rows for the same inputs).
  - With a lesson set to `CHECKPOINT` in a fixture, `isCompleted: true` alone produces no ledger row; a qualification row produces exactly one.
  - A user already awarded under legacy receives nothing further after the lesson's policy changes.
  - A user awarded a lesson under legacy can still complete the course reward after that lesson switches to the checkpoint policy, without answering its checkpoint.
  - An owner receives no course reward on their own course.
- **Testing:** L1 with fixtures for both policies. L2: concurrent settle calls produce one ledger row.
- **Regression risks:** reward redemption and refund paths share the ledger but not these helpers; they must be untouched.
- **Decision blockers:** D-05 fixes the checkpoint shape before the migration is written. Proposed default: one multiple-choice question per lesson.

### P17 — Checkpoint authoring for creators

- **Priority and complexity:** P1, M.
- **Problem and evidence:** Creators configure rewards per lesson in the lessons page (`src/app/(withSidebar)/dashboard/creator/courses/[id]/lessons/page.tsx:220-231`) but have no way to define a server-evaluated requirement.
- **Desired outcome:** A creator can write, preview and publish a checkpoint for a lesson, then switch that lesson to the checkpoint policy. Nothing changes for learners until the switch.
- **Scope:** new `src/app/api/creator/lessons/[id]/checkpoint/route.ts`; the lessons page; `src/app/api/creator/lessons/route.ts` (accept `participationPolicy`).
- **Implementation requirements:**
  1. GET returns the creator's draft and latest published version, including the correct answer, to the owning creator only.
  2. PUT saves a draft. POST `publish` creates the next version as `PUBLISHED` and retires the previous one. Published versions are immutable.
  3. A lesson may be set to `CHECKPOINT` only when a published checkpoint exists. The switch is one-way through the API (D-06).
  4. Editing content or publishing a new checkpoint version never deletes `LessonQualification` rows.
  5. The editor states plainly what learners will see and that points are granted only after a correct answer.
- **Dependencies:** P16.
- **Compatibility and migration:** none beyond P16.
- **Acceptance criteria:** a non-owner creator and any learner receive 404 from the authoring API; the policy cannot be set to `CHECKPOINT` without a published version; publishing twice yields versions 1 and 2 with only 2 published.
- **Testing:** L1 for ownership, versioning and the switch precondition. L3: author and publish.
- **Regression risks:** lesson save and video upload flow in the same page (P06 behavior).
- **Decision blockers:** D-06 (one-way switch; proposed yes).

### P18 — Learner checkpoint flow and policy disclosure

- **Priority and complexity:** P1, M. This is the phase that changes reward behavior for transitioned lessons.
- **Problem and evidence:** See P16. Learner copy today does not say how a reward is earned.
- **Desired outcome:** On a checkpoint lesson, a signed-in learner with access answers the checkpoint; a correct answer records qualification on the server and grants the reward once. Completion flags and seeking grant nothing on these lessons. Legacy lessons continue to work and are described accurately.
- **Scope:** new `GET` and `POST src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/checkpoint`; `src/app/api/progress/lesson/route.ts`; `src/components/experience/lesson-client.tsx`; lesson API response (`src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/route.ts`) to expose `participationPolicy` and reward copy.
- **Implementation requirements:**
  1. GET returns prompt and options for the published version. Never the answer.
  2. POST requires a signed-in user, a published experience (P03), an active lesson and course, and private-course access where applicable. It records an attempt, enforces an attempt limit (proposal: 3 attempts per 10 minutes per user per checkpoint, 429 beyond), and on a correct answer creates the qualification row (unique per user and lesson, so repeats are no-ops) and calls `settleLessonAward` then `settleCourseAward`.
  3. The progress route keeps saving position and `isCompleted` for every lesson. For checkpoint lessons it does not call the award service.
  4. Anonymous viewers can watch and see the checkpoint prompt. Submitting requires sign-in. Anonymous completion flags on checkpoint lessons transfer as progress only (D-05).
  5. Copy: legacy lessons say "Finish this lesson to earn N points". Checkpoint lessons say "Answer the checkpoint to earn N points". No surface uses the word "verified" for a legacy lesson.
  6. State the limit honestly in `docs/points-ledger.md`: a multiple-choice checkpoint shows engagement with the content. It does not prove attention.
- **Dependencies:** P17. P03 for the publication and owner rules.
- **Compatibility and migration:** existing ledger rows and legacy progress are untouched. A learner who self-reported completion on a lesson before it transitioned keeps `isCompleted` and, if already awarded, their points; if not awarded, P19 handles the claim.
- **Acceptance criteria:**
  - On a checkpoint lesson, posting `isCompleted: true` or seeking to the end creates no ledger row.
  - A correct answer creates one qualification row and one ledger row; repeating it creates neither.
  - A wrong answer creates an attempt row only; the fourth attempt inside the window returns 429.
  - The answer index never appears in any learner response.
  - The owner answering their own checkpoint earns nothing.
- **Testing:** L1 for every branch and the serialization check. L2: concurrent correct submissions yield one ledger row. L3: learner walk-through on uploaded and YouTube lessons.
- **Regression risks:** resume position, course progress percentages, `lesson_completed` analytics events.
- **Decision blockers:** D-05 (attempt limits, sign-in requirement).

### P19 — Course qualification and legacy transition

- **Priority and complexity:** P2, M.
- **Problem and evidence:** Course rewards are evaluated against whatever lessons are active at the moment of the call (`src/lib/points.ts:612-637`), so the requirement shifts as lessons are added or removed. When a lesson moves to the checkpoint policy, learners with a legacy completion and no award have a claim that current code would neither grant nor record.
- **Desired outcome:** Course rewards are evaluated against a recorded requirement version. Legacy completions without an award at transition time become explicit reviewable claims. Nothing is auto-granted, dropped or clawed back.
- **Scope:** migration adding `CourseRequirementVersion { id, courseId, version, lessonIds Json, createdAt }`, `CourseQualification { userId, courseId, requirementVersion, qualifiedAt, @@unique([userId, courseId]) }` and `LegacyRewardClaim { id, userId, lessonId, status (PENDING_REVIEW | GRANTED | DECLINED), decidedById?, decidedAt?, createdAt, @@unique([userId, lessonId]) }`; `src/lib/learning-awards.ts`; the P17 policy switch; an admin review list; every writer that changes a course's set of active lessons: lesson create, update and delete in `src/app/api/creator/lessons/route.ts`, and course update and delete in `src/app/api/creator/courses/route.ts`.
- **Implementation requirements:**
  1. Create a new requirement version whenever the set of active lessons in a rewarded course changes, inside the same transaction as that change, through one helper called by every writer listed in Scope. `settleCourseAward` evaluates the latest version and writes `CourseQualification` with that version before awarding.
  1a. A rewarded course that has no version yet (every existing course at deployment) gets version 1 created lazily, from its active lessons at that moment, the first time it is evaluated or changed. No versions are created at deploy time and none are dated in the past.
  2. On a lesson's switch to `CHECKPOINT`, in the same transaction, insert a `LegacyRewardClaim` (`PENDING_REVIEW`) for each user with `isCompleted` on that lesson and no `lesson-completion:{lessonId}` ledger row, when the lesson's reward is positive.
  3. Admin review grants or declines through a function in `learning-awards.ts`, so the P16 rule that only that module calls the award helpers still holds. A grant awards with the unchanged key. Both outcomes write an audit event (P15).
  3a. A granted claim produces a `lesson-completion` ledger row, which P16 item 3 already counts toward the course. A declined or pending claim does not count; the learner can still qualify by answering the checkpoint.
  4. Learners see "Reward under review" for a pending claim on that lesson.
  5. Do not create claims retroactively for lessons that never transition.
- **Dependencies:** P18. P15 for audit.
- **Compatibility and migration:** additive. Users already holding the course reward never re-earn it (ledger key). Requirement versions start at the time of deployment; no historical versions are invented.
- **Acceptance criteria:** adding a lesson to a course does not revoke an awarded course reward and does not let an awarded user earn again; a transition with three unsettled legacy completions creates three pending claims and zero ledger rows; granting one creates one ledger row and lets that learner's course reward settle; an existing rewarded course with no version is evaluated correctly on first use.
- **Testing:** L1 and L2 (transition transaction atomicity).
- **Regression risks:** course progress display; P09 settlement must skip lessons with a pending claim.
- **Decision blockers:** D-06 (who reviews legacy claims; proposed: superadmin).

### P33 — Campaign workspace and readiness

- **Priority and complexity:** P3, L. New contextual structure over existing screens. Review after the layout lands, before readiness rules.
- **Problem and evidence:** Campaign work is spread across `campaigns/[id]/edit`, `campaigns/[id]/experiences`, `campaigns/[id]/products`, the global `qr-batches` page, the global rewards page and the global analytics page, with no shared campaign context and no readiness concept.
- **Desired outcome:** Inside a campaign, a persistent header and tabs link identity, experiences, products, rewards, QR distribution and analytics, each scoped to that campaign. A readiness summary guides without forcing an order.
- **Scope:** a layout at `src/app/(withSidebar)/dashboard/brand/campaigns/[id]/layout.tsx`; new `GET /api/brand/campaigns/[id]/readiness`; scoped links into existing global pages using their filters (P26, P29, P32).
- **Implementation requirements:**
  1. Tabs link to existing pages. No page is removed. Global QR and content lists stay for bulk work.
  2. Readiness items carry one of four levels. Blocker: no published experience attached. Warning: an attached experience is a draft; no QR codes exist; codes exist but were never exported. Optional: no curated products; no reward offer. Provider limitation: connection lacks the scope or capability needed for order attribution.
  3. Readiness is advisory. It never disables saving or activating a campaign. A campaign with experiences and no commerce shows no blocker.
  4. Show creator identity on attached experiences.
- **Dependencies:** P26, P27, P29.
- **Compatibility and migration:** all existing URLs keep working.
- **Acceptance criteria:** every tab opens the existing screen filtered to the campaign; a content-only campaign reports ready; each readiness item links to the place to fix it.
- **Testing:** L1 for readiness rules with fixtures. L3: walk the flow in any order.
- **Regression risks:** brand layout access gating (`src/app/(withSidebar)/dashboard/brand/layout.tsx:14-47`).
- **Decision blockers:** none beyond confirming the readiness rule list above.

### P34 — Experience workspace for creators

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Creator pages for one experience (edit, courses, posts, Q&A, analytics) do not share context; Q&A and analytics are global pages with an optional experience filter.
- **Desired outcome:** Inside an experience, a persistent header shows its title and publication state, with links to content, posts, questions and analytics scoped to it, and a public-view link for published experiences.
- **Scope:** a layout at `src/app/(withSidebar)/dashboard/creator/experiences/[id]/layout.tsx`; creator overview additions (unanswered question count, drafts with attached campaigns).
- **Implementation requirements:** link to `creator/qa?experienceId=` and `creator/analytics?experienceId=`; For published experiences, open `/x/{slug}`; drafts stay in authenticated creator-management screens and have no public-route preview; overview counts come from existing queries.
- **Dependencies:** P25. P03 for publication enforcement.
- **Compatibility and migration:** existing URLs keep working.
- **Acceptance criteria:** from any experience page the creator reaches its Q&A and analytics already filtered; a draft shows "Draft" and remains editable in authenticated management; its public viewer returns 404.
- **Testing:** L1 for overview counts. L3.
- **Regression risks:** creator layout role guard.
- **Decision blockers:** none.

### P40 — Operations visibility

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Workers run in bounded batches with ownership claims (email 25 per run at `src/lib/welcome-email-worker.ts:3`; reward reconciliation 20 at `src/lib/reward-reconciliation.ts:243`; Commerce7 provisioning 1 per run at `src/lib/commerce7-rewards.ts:577`), but nothing reports backlog size or the age of the oldest pending item. Approval age and connection health are not summarized anywhere.
- **Desired outcome:** A superadmin operations view shows, read-only: pending email count and oldest age; stuck redemptions and oldest age; Commerce7 reconciliation backlog; per-connection sync freshness and unhealthy connections; oldest pending approval; staged-asset backlog when P13 is shipped. A brand commerce view shows sync freshness, ingestion lag and attribution coverage for that brand.
- **Scope:** new `GET /api/admin/operations`; a page under `dashboard/admin`; additions to the brand Store page.
- **Implementation requirements:** read-only aggregate queries only; admin-gated; no customer personal data; no change to worker batch sizes, claims or locks. Ingestion lag is `createdAt - providerCreatedAt` summarized as median and maximum for recent orders.
- **Dependencies:** P15 (approval timestamps), P28 (sync run display).
- **Compatibility and migration:** none.
- **Acceptance criteria:** figures match direct counts in a fixture; the page performs no writes.
- **Testing:** L1.
- **Regression risks:** query cost on large tables; keep each query indexed or bounded.
- **Decision blockers:** none.

### P41 — Funnel stage counts

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Stage data exists in separate tables: scans and views (`AnalyticsEvent`), unlocks (`CampaignUnlock`), lesson starts and completions (`AnalyticsEvent`, `LessonProgress`), merchant handoff (`CommerceClickAttribution`), orders (`CommerceOrder`). No report lines them up, and no cohort join exists that would justify a rate.
- **Desired outcome:** Campaign and experience analytics show a count for each stage in a period, each with its own stated date basis. No stage-to-stage percentage is shown.
- **Scope:** a new builder in `src/lib`; brand campaign analytics and creator experience analytics panels.
- **Implementation requirements:** stages are entry, unlock, learning start, completion (and qualification when available), merchant handoff, attributed order, order with positive current net value. Label counts as events, not people, because anonymous and signed-in activity is not deduplicated. Add the caption "Stage counts for the period. These are not conversion rates." Do not divide one stage by another.
- **Dependencies:** P37, P38, P39.
- **Compatibility and migration:** none.
- **Acceptance criteria:** each stage count equals a direct query for the same period and basis; no percentage between stages appears.
- **Testing:** L1.
- **Regression risks:** none beyond query cost.
- **Decision blockers:** none. A true conversion rate needs a defined cohort and observation window and is deferred (see outstanding issues).

### P42 — Measured aggregation performance

- **Priority and complexity:** P3, M. Conditional on measurement.
- **Problem and evidence:** Conversion routes load every matching order with line items and aggregate in application code (`src/app/api/brand/analytics/conversions/route.ts:201-232`; `src/lib/commerce/order-analytics.ts:245-282`). The only bound is the 400-day range cap. No latency or volume baseline exists.
- **Desired outcome:** A recorded baseline of rows loaded, response size and server time for representative brands. Database-side aggregation is introduced only if the baseline crosses a threshold agreed with the owner.
- **Scope:** lightweight timing and row-count logging in the conversions routes; a short results note appended to this plan's follow-up or to `docs/commerce`; optionally `src/lib/commerce/order-analytics.ts`.
- **Implementation requirements:** log counts and durations only, with no identifiers beyond brand id. If aggregation is justified, move sums and counts to `groupBy` or SQL while keeping per-currency separation, the tenant filter and identical outputs, verified by running old and new builders side by side in tests.
- **Dependencies:** P38.
- **Compatibility and migration:** none unless an index is proposed, in which case it is its own reviewed migration.
- **Acceptance criteria:** baseline recorded; if code changes, outputs are identical for the fixture set.
- **Testing:** L1 equivalence tests; L2 for query plans if aggregation is added.
- **Regression risks:** BigInt handling and currency grouping.
- **Decision blockers:** the threshold. Proposal: act when a single request loads more than 10,000 orders or exceeds two seconds server time.

### P43 — Navigation and entry-point consolidation

- **Priority and complexity:** P3, L. Do this last, after the contextual workspaces prove useful.
- **Problem and evidence:** Navigation is a flat list per role (`src/components/app-sidebar.tsx`). User management lives at `(withSidebar)/admin/user-management` while other admin pages live under `dashboard/admin`, and `dashboard/admin/users` only redirects. Contact and Support repeat the same contact details (`src/app/contact/page.tsx:13-14`; `src/app/support/page.tsx:13-14`). `/home` and `/generateQR` remain as legacy entry points.
- **Desired outcome:** Customer: Home, My Learning, Points and Rewards, Account and Help. Creator: Overview, Experiences, Questions, Analytics. Brand: Overview, Campaigns, Commerce, Rewards, Analytics, Settings. Superadmin: Overview, Approvals, Accounts and Brands, Campaigns, Operations. Every existing URL still resolves.
- **Scope:** sidebar data; redirects for moved pages; one shared contact block used by both Contact and Support.
- **Implementation requirements:** move pages only where capability parity is confirmed; add permanent redirects for every moved path; keep global QR and content lists; keep `/redeemQR/...` and `/q/...` untouched; list every old path and its destination in the commit.
- **Dependencies:** P23, P33, P34.
- **Compatibility and migration:** redirects preserve bookmarks and printed links.
- **Acceptance criteria:** a scripted list of all pre-change routes returns 200 or a redirect to a working page; role guards are unchanged.
- **Testing:** L1 route inventory test. L3 per role.
- **Regression risks:** middleware matcher paths (`src/middleware.ts:71-80`); Shopify embedded entry (`/shopify`).
- **Decision blockers:** owner sign-off on the final menu after using P33 and P34.

---


## 4. Remaining decisions and migration prerequisites


Each has a proposed default. Phases proceed on the default unless you say otherwise. D-03 (an existing anonymous unlock still converts after a stop) was adopted in P12.

| ID | Decision | Proposed default | Consequence of the alternative | Blocks |
|---|---|---|---|---|
| D-04 | Should `Campaign.isActive` or `Brand.isActive` block scans or public campaign pages? | Not in this plan. Decide after the read-only count of `isActive = false` rows | Enforcing now could invalidate printed codes for campaigns marked inactive for unrelated reasons | none |
| D-05 | Checkpoint format and limits | One multiple-choice question per lesson, answer held server-side, sign-in required to submit, 3 attempts per 10 minutes | Free-text or multi-question checkpoints need a larger authoring tool; allowing anonymous submission needs qualification transfer in P09 | P16, P18 |
| D-06 | How do rewarded legacy lessons transition, and who reviews unsettled legacy claims? | Creators switch per lesson, one-way. Legacy lessons keep awarding until switched. Superadmin reviews claims | A forced cutoff date would stop legacy awards for creators who have not authored a checkpoint | P17, P19 |
| D-10 | When does the expected-brand header become mandatory? | One release after P07 | Immediate enforcement breaks tabs opened before deploy | P07 |
| D-13 | Applicant-facing reason versus internal note | Existing `reason` is applicant-facing; add `internalNote` | Treating existing reasons as internal would hide past explanations from applicants | P15 |
| D-15 | Shared rate-limit store | Implemented as an opt-in PostgreSQL table (`RATE_LIMIT_STORE=postgres`) for sign-in and recovery endpoints; a managed key-value store remains possible if scan limits must be deployment-wide | A managed store adds a service; Postgres adds write load, which is why hot paths stay in memory | none |
| D-16 | Is there a budget or cap on creator-configured rewards, given that points are redeemed against brand offers? | Not decided here. Flagged because checkpoints do not address it | Without one, a creator and a second account can still mint up to 1000 points per lesson | none; new product work |

---


### E.1 Operator prerequisites before any migration phase

These are run by the owner, not by an agent.

1. `npx prisma migrate status` against production, then `prisma migrate diff` as described in `docs/prisma-migrations.md`.
2. Run the read-only drift query from P01 once, and keep the result.
3. Run the read-only count of `QRCode`, `QRCodeBatch` and `Campaign` rows with `isActive = false` (informs D-04), and the shared-storage-path check in `docs/lesson-video-uploads.md` before scheduling the asset sweeper.

### E.2 Migration inventory

All are additive and nullable or defaulted. None has a backfill.

| Phase | Change | Preflight | Dual-format period |
|---|---|---|---|
| P12 *(branch)* | `QRCode.redemptionStoppedAt`; `QRCodeBatch.redemptionStoppedAt`, `redemptionStoppedById` | count of `isActive = false` rows for information | Null means redeemable; scan page and API ship together |
| P13 *(branch)* | `StagedAsset` table | none | Uploads authorized before deploy have no row; attach adopts one |
| P37 *(branch)* | `LessonProgress.completedAt` | none | Null reported as "date not recorded" |
| P44 *(branch)* | `RateLimitCounter` table, used only with `RATE_LIMIT_STORE=postgres` | none | In-memory fallback; safe to apply before or after the release |
| P15 | `AdminAuditEvent`; `reviewedAt`, `internalNote` on both request models | none | Null `reviewedAt` shown as not recorded |
| P16 | Policy enum and column; checkpoint, qualification and attempt tables | none | Default policy is legacy for every lesson |
| P19 | Requirement version, course qualification and legacy claim tables | none | Versions start at deployment; none invented for the past |

Rules for every migration: one folder per phase; enum additions are not reversible, so P16's enum is reviewed with extra care; index creation on large tables is called out for a low-traffic window; rollback is "stop reading and writing the new column", never a destructive down migration.

### E.3 Sequencing constraints

- **P16 to P19 in order.** P16 changes nothing visible. P18 is the first phase that changes how a reward is earned, and only for lessons a creator has switched.
- **P04 and P05 before P15.** Audit rows are written inside the transactions those phases create.

### E.4 Rollout transitions that support old and new behavior together

| Phase | Old clients or data | New behavior | When to close the transition |
|---|---|---|---|
| P07 | Tabs loaded before deploy send no expected-brand header | Enforced only when present | One release later, require the header on brand mutations |
| P13 *(branch)* | Objects without a staged row | Adopted at attach | Remove the adoption fallback after one release |
| P12 *(branch)* | Scan page treating any non-OK as invalid | New 409 `QR_REDEMPTION_STOPPED` with message | Same release |
| P16 | Lessons with rewards under self-reported completion | Policy column, default legacy | Per lesson, when its creator switches |

### E.5 Rollback notes

- Code-only phases (P21, P24, P27 to P35, P39 to P43) roll back by revert. P02 deletes route files; revert restores them.
- P01 and P02 must not be reverted independently of each other once shipped, or the legacy routes return without the guard.
- Migration phases roll back by reverting code and leaving columns in place.
- P12 is the one phase where a rollback changes user-visible state (this round): codes stopped while it was live become redeemable again if the predicate is removed. Resume them deliberately before reverting, or keep the predicate.
- P18 rollback returns transitioned lessons to no-award-on-flag only if the policy column is still honored. Do not revert P16 while any lesson is on the checkpoint policy.

---


## 5. Safety and regression rules

- Never use ambient `DATABASE_URL` in Prisma, tests or scripts. Use the P00 gated lane only against a verified disposable loopback `_test` database; connected Supabase and shared databases are read-only. Inspect schema/migrations; author additive migrations with preflight and rollback notes, never apply them without explicit authorization. Owner verifies deployment drift (X-10).
- Never delete ledger, unlock, redemption or attribution history. Keep `applyPointLedgerEvent`, immutable idempotency keys, guarded `NEW` transitions, row locks, and existing printed redirects. Reconcile historical drift only by a separately approved data decision.
- Resolve user, creator, campaign and brand authority server-side; expected-brand headers only detect stale state and never grant access. Preserve VIEWER restrictions, private-course unlock checks, session revocation, active ADMIN protection and owner-only management authorization. Draft public routes return 404 for everyone.
- Keep provider-neutral `CommerceConnection` canonical; verify webhooks before processing. Orders do not imply payment; refunds and cancellations adjust net analytics without erasing historical attribution. Do not execute real provider mutations during QA.
- Do not expose customer PII to creators, store only opaque attribution evidence in external carts, or widen analytics allowlists. Protect issued media URLs according to their existing TTL; never promise immediate revocation.
- Preserve existing data and uncommitted work. Test mock, disposable PostgreSQL concurrency, owner browser procedures and authorized provider sandboxes as applicable. Do not report unexecuted acceptance checks as passed.
