# AUDIT.md — AI System Audit Framework

> **Instructions for Claude:** You are now acting as a production-grade auditor of this codebase and running application. Work through every section below systematically. For every issue you find, output a full issue report using the template in Section 0. Never skip sections. Never assume behaviour is correct without verifying it. Think simultaneously as a QA Engineer, Senior Frontend Engineer, Senior Backend Engineer, Security Engineer, Accessibility Specialist, Performance Engineer, DevOps Engineer, Product Designer, UX Researcher, Real End User, Malicious User, and Scalability Consultant.

---

## How To Run This Audit (Operating Protocol)

Read this section before starting. It governs *how* you work through every section that follows. The checklists tell you **what** to check; this tells you **how** to check it so nothing is missed and nothing is falsely passed.

### The one rule
**You may never decide the audit is finished — you must prove it.** Do not write "looks good", "no issues found", or tick a box without having actually verified the thing. A ticked box with no evidence is a failure of the audit, not a pass.

### The evidence rule
A check is only "passed" when you can state *how you know*. Tag every verification with its mode:
- **[code]** — verified by inspecting source; name the file/component/function/line.
- **[ran]** — verified by performing the action in the running app and observing the result.
- **[test]** — verified by a passing test (or one you wrote) that exercises it.
- **[search]** — to claim something is absent or unused, state the exact search terms used. Absence must be shown, not assumed.

**Critical:** behaviour, interaction, visual, responsiveness, and runtime checks cannot be honestly passed with **[code]** alone — reading the source does not tell you what the app *does*. If you cannot run the app, any such check is **Unverified**, not passed. Mark it so. A behaviour box ticked on the strength of reading code is exactly the shallow pass this audit exists to prevent.

If you cannot produce evidence, the item is **Unverified** → log it in the Coverage Tracker (final section) with the reason. Never guess silently.

### Can you run the app?
Before starting, establish whether you can execute and interact with the running application, or only read its code. State which, explicitly, at the top of your output. This determines which sections can be fully completed:
- **Code only** → static-analysable sections (code quality, architecture, security patterns, schema, SEO tags, redundancy) can reach Done; behaviour/interaction/visual/responsiveness sections will be partly Unverified — list exactly what a runtime pass still needs to cover.
- **Can run it** → no excuse for an Unverified behaviour check; actually exercise the app.

### The method for every section
1. **Discover before judging.** Before assessing an area, inventory what's actually there (the routes, components, models, endpoints, jobs involved). You cannot audit what you haven't mapped.
2. **Understand intent.** State what the feature is *supposed* to do, then audit the implementation against that — this catches *missing* behaviour, not just broken behaviour.
3. **Check the list.** Work the section's checkboxes, producing evidence per the rule above.
4. **Trace the ripples (Section A).** For anything that creates or changes data, follow it everywhere it should propagate.
5. **Re-attack (adversarial pass).** Once you conclude an area is clean, discard that conclusion and re-examine it as a hostile reviewer trying to prove the first pass wrong. Assume the previous engineer missed something; you are rewarded for finding it. Only when a hostile pass finds nothing new is the area done.

### Severity is decided by impact, not effort
Critical = data loss, security breach, or a core workflow broken. High = a feature broken or a real risk. Medium = wrong behaviour in an edge case or notable debt. Low = cosmetic or minor inconsistency.

---

## Section D — Discovery & Inventory (Do This First, Before Any Checks)

> This section exists because the biggest cause of missed issues is **whole areas the agent never looked at**. You cannot audit what you have not enumerated. Before running a single checklist below, build and **output** the following inventories. Every later section is checked against these lists, and the Completion Gate verifies every item was covered. If you skip this, the audit is invalid.

> Build each inventory by searching the codebase exhaustively — do not list from memory or assumption. For each, state how you found it (the directories, route files, schema, config you read). If the app can be run, also walk it to catch anything the code didn't obviously reveal.

### D.1 Screen / Page Inventory
List every screen, page, view, and modal in the application. For each: name, route/path, the roles that can reach it, and its purpose. **This is the master list — every screen here must be accounted for in the UI, UX, Responsiveness, Accessibility, and Behaviour sections.**

### D.2 Route / Endpoint Inventory
List every frontend route and every backend endpoint (method + path). Mark which require auth and which roles.

### D.3 Workflow Inventory
List every user workflow and every system/background workflow (e.g. "create booking", "cancel booking", "nightly reminder job", "export report"). **This is the master list for Section A — every workflow here must be traced end-to-end.**

### D.4 Entity / Data Model Inventory
List every data entity/table and its key relationships. **This is the master list for the Data, Database, and Business Logic sections.**

### D.5 Component Inventory
List every reusable UI component and note obvious duplicates or near-duplicates (two things doing the same job). **This feeds the Consistency and Redundancy passes.**

### D.6 Interaction & State Inventory
List every interactive element type (buttons, forms, dropdowns, drag/drop, etc.) and every significant piece of application state. Note what is meant to happen on each interaction.

### D.7 Integration Inventory
List every third-party integration, external API, scheduled job, notification/email, webhook, and feature flag.

> **Output all seven inventories before proceeding.** They are the spine of the audit. The Completion Gate (Section 30) will require you to show that every screen, workflow, and entity on these lists was actually examined — this is what makes "I checked everything" provable instead of assumed.

---

## Section 0 — Issue Report Template

Use this exact structure for every issue discovered. Do not abbreviate.

```
## [Issue Title]

### Severity
Critical | High | Medium | Low

### Category
UI | UX | Accessibility | Performance | Security | Backend | Frontend | API | SEO | Architecture | Code Quality | Responsiveness | Validation | Logic

### Description
[Clear explanation of the issue.]

### Steps To Reproduce
1.
2.
3.

### Expected Behaviour
[What should happen.]

### Actual Behaviour
[What actually happens.]

### Impact
- Users: [effect on end users]
- Business: [revenue, retention, reputation]
- Developers: [maintainability, debugging burden]
- Scalability: [how this compounds at scale]

### Root Cause
[Likely technical root cause. Reference specific files, components, functions, or queries if identifiable.]

### Recommended Fix
[Concrete fix with code snippets or config changes where applicable.]
```

---

## Section A — Workflow & Propagation Audit (Hidden Dependencies)

> This is the highest-value section. Most "the AI missed it" bugs are not broken components — they are changes that fail to ripple to everywhere they should. A feature works in isolation but a dependent view, job, or record never gets updated. Run this against every create/update/delete workflow in the application.

### A.1 For Every Workflow, Trace The Full Chain
For each action that creates, updates, or deletes data, verify every downstream effect actually happens:
- [ ] Trigger fires correctly (button, API call, scheduled job, event)
- [ ] Validation runs before the change
- [ ] Permission/authorisation is checked before the change
- [ ] The database write succeeds and is atomic
- [ ] Related records are updated (not left stale)
- [ ] Events/webhooks fire where expected
- [ ] Notifications/emails are sent where expected
- [ ] The list/table view reflects the change
- [ ] The detail view reflects the change
- [ ] Search results/indexes reflect the change
- [ ] Filters and sorts account for the changed data
- [ ] Dashboards and summary widgets recalculate
- [ ] Calendars/reminders/scheduled items update
- [ ] Reports reflect the change
- [ ] Exports (CSV/PDF) include the change
- [ ] The audit log records the change
- [ ] Caches are invalidated
- [ ] The API response reflects the change
- [ ] Mobile/other clients reflect the change

### A.2 The Recursive Question
For every workflow, repeatedly ask **"what else should happen when this happens?"** and follow each answer until no new dependency appears. Example — adding an expiry date to a record should ripple to: the create form, the edit form, the list column, sorting, filtering, the reminder job, the "expiring soon" dashboard widget, search, exports, the audit log, and renewal/expiry handling. If any link in that chain is missing, that is at least a High-severity issue.

### A.3 The Dependency Sweep
For every important entity, ask and verify: what **reads** this, what **writes** this, what **deletes** this, what **displays** this, what **calculates from** this, what **caches** this, what **schedules** on this, what is **notified** by this, what **reports** on this, what **exports** this. Each unanswered question is a gap to investigate.

---

## Section B — Business Logic & Data Integrity Audit

> Technical correctness is not enough — the application must do the *right thing* and keep its data trustworthy.

### B.1 Intent vs Implementation — Verify
- [ ] Each feature actually fulfils its intended business purpose
- [ ] Workflows match how a real user expects the process to work
- [ ] No missing functionality the feature logically requires
- [ ] No contradictory behaviour between related features
- [ ] Business rules are enforced consistently everywhere they apply (not just in one place)
- [ ] Edge cases of business rules are handled (zero, negative, maximum, expired, cancelled states)

### B.2 Single Source of Truth — Detect
- [ ] The same fact stored in multiple places that can disagree
- [ ] Derived values cached/stored separately from their source and able to drift
- [ ] Validation logic duplicated and inconsistent between client, server, and database
- [ ] The same business rule implemented differently in different modules
- [ ] Formatting (date, currency, number) handled inconsistently across the app

### B.3 Data Lifecycle — Verify For Key Data
- [ ] Input is validated at the boundary
- [ ] Data is sanitised before storage
- [ ] Authorisation governs who can read/write it
- [ ] It is consistent everywhere it is displayed
- [ ] Deletion/archival is handled (and cascades correctly)
- [ ] It can be recovered or is intentionally permanent (documented either way)

---

## Section C — Cross-Cutting Consistency Audit (Whole-App Drift)

> These issues are invisible to a per-screen checklist because they are properties of the *whole app*, not any one component. Two screens each look fine alone but disagree with each other. Audit each property **across every screen in the D.1 inventory at once**, comparing them — not one screen in isolation.

### C.1 Visual & Design Consistency — Compare Across All Screens
- [ ] Spacing scale is the same everywhere (no one-off margins/paddings)
- [ ] Typography scale is identical across screens (same heading sizes, weights, line-heights)
- [ ] Colour usage matches the design tokens everywhere (no rogue hex values on isolated screens)
- [ ] Border radius, shadows, and borders are consistent across all components
- [ ] Buttons look and behave identically for the same action type across screens
- [ ] Icons come from one set at consistent sizes
- [ ] Form fields, labels, and validation styling are identical app-wide
- [ ] Loading, empty, and error states look the same wherever they appear
- [ ] The same component is genuinely the same component, not re-implemented per screen

### C.2 Behavioural Consistency — Compare The Same Action Across The App
- [ ] The same action (save, delete, cancel) behaves identically everywhere it appears
- [ ] Destructive actions are confirmed consistently (not guarded on one screen, unguarded on another)
- [ ] Success feedback is delivered the same way across all features (toast vs inline vs nothing)
- [ ] Error handling and messaging follow one pattern app-wide
- [ ] Keyboard behaviour (Enter submits, Esc closes) is consistent across all dialogs/forms
- [ ] Optimistic vs pessimistic update behaviour is consistent for similar actions
- [ ] Navigation patterns (where "back" goes, how breadcrumbs work) are predictable everywhere

### C.3 Content & Terminology Consistency
- [ ] The same concept uses the same word everywhere (not "client" on one screen, "customer" on another)
- [ ] Date, time, number, and currency formatting is identical app-wide
- [ ] Capitalisation and tone of labels/buttons follow one convention
- [ ] Empty-state and error copy follow a consistent voice

### C.4 Route & Structure Consistency
- [ ] URL/route naming follows one convention (no `/admin/tickets/123` vs `/admin/support/t1`)
- [ ] Similar pages are structured similarly (list → detail → edit patterns match)
- [ ] Permission checks are applied consistently to equivalent resources

---

## Section E — Expected Capabilities Audit (What Should Exist But May Be Missing)

> Every other section inspects what *is* there. This section catches what *should* be there and isn't — the most invisible class of issue, because missing features have no code to review and silently pass every other check. A dynamic web application is not a static website: if it stores data, users expect to manage that data; if it has accounts, users expect to control them; if it has configuration, users expect to change it themselves without a developer.
>
> **How to run this section:** it is conditional. For each trigger below, if the app has the thing on the left, assert the capabilities on the right *should* exist, then search the app (code + running) to confirm. **If a capability is absent, that absence is the finding** — log it as a missing-feature issue (Severity by how core it is). Do not assume it exists; do not assume it's out of scope. If it's genuinely intended to be absent, that should be a deliberate, stated decision, not a silent gap.

### E.1 If there is a DATABASE / stored data → expect data controls
For every significant entity (from the D.4 inventory), verify the user can actually manage it:
- [ ] Create — users can add records through the UI (not only via seed/admin/DB)
- [ ] Read — users can view records, including a list and a detail view
- [ ] Update — users can edit records after creation
- [ ] Delete — users can remove records (with confirmation), or archive where deletion is unsafe
- [ ] Search / filter / sort on meaningful fields where the list can grow
- [ ] Pagination or virtualisation when lists can grow large
- [ ] Bulk actions where managing many records is expected
- [ ] Import / export where the data volume or workflow implies it
- [ ] Validation and clear errors on every create/update path

### E.2 If there are USER ACCOUNTS → expect account management
- [ ] Sign up / registration (if self-serve) and login
- [ ] Logout that fully ends the session
- [ ] Password reset / "forgot password" flow
- [ ] Change password while logged in
- [ ] Update own profile (name, email, avatar, etc.)
- [ ] Change email, with verification of the new address
- [ ] Email verification on signup (if required)
- [ ] Delete or deactivate own account (and a clear data-handling outcome)
- [ ] Session management — sessions expire; ideally view/revoke active sessions
- [ ] Multi-factor / 2FA where the data sensitivity warrants it
- [ ] Roles and permissions are actually editable by an admin, not hardcoded

### E.3 If there is CONFIGURATION → expect it to be user-editable (dynamic, not hardcoded)
The app should let the appropriate user change settings without a code change. For each configurable concern, verify there is a settings UI and it persists and takes effect:
- [ ] Notification / system email addresses are editable in-app (not hardcoded in source)
- [ ] Email templates / sender details are configurable where the app sends mail
- [ ] Business rules that obviously vary (tax rates, fees, limits, thresholds, working hours) are settings, not constants
- [ ] Branding (logo, name, colours) is configurable if the app is meant to be themed/white-labelled
- [ ] Feature toggles are controllable by an admin where features are meant to be optional
- [ ] Integrations (API keys, webhook URLs, third-party credentials) are entered/managed in-app
- [ ] Defaults, dropdown option lists, categories, and lookup values are editable rather than fixed in code
- [ ] Changing a setting takes effect immediately and everywhere it applies (ties to Section A propagation)
- [ ] Settings are permission-gated (only the right roles can change them)
- [ ] Settings persist across restarts/deploys (stored, not in-memory)

### E.4 If there are NOTIFICATIONS / EMAILS → expect control over them
- [ ] Users can see and manage their notification preferences
- [ ] Unsubscribe / opt-out exists where legally and practically expected
- [ ] The user controls which events notify them, where that's reasonable

### E.5 If there is MULTI-TENANCY / ORGANISATIONS → expect tenant controls
- [ ] An org/team owner can invite, remove, and re-role members
- [ ] Data is isolated per tenant (verify one tenant cannot see another's data)
- [ ] Org-level settings are separate from user-level settings

### E.6 General "is it actually dynamic?" sweep
- [ ] Walk the app and list everything currently hardcoded that a real operator would expect to change themselves
- [ ] For each, decide: should this be a setting? If yes and it isn't, that's a finding
- [ ] Confirm there is an admin/settings area appropriate to the app — its absence in a dynamic app is itself a finding

---

## Section 1 — General Application Audit

### 1.1 Verify
- [ ] Application loads successfully with no blank pages or crashes
- [ ] No hydration issues (if SSR/SSG is used)
- [ ] No infinite loading states
- [ ] No memory leaks on repeated use
- [ ] No console errors or runtime warnings
- [ ] No network request failures
- [ ] No duplicated or redundant network requests
- [ ] No stale state from previous sessions
- [ ] No flickering or layout shifting on load
- [ ] No frozen UI under normal interaction
- [ ] No broken navigation or dead links
- [ ] No inconsistent rendering across page visits

### 1.2 Check
- [ ] Browser refresh restores correct state
- [ ] Deep linking to routes works correctly
- [ ] Cache invalidation is handled properly
- [ ] Browser history (back/forward) behaves correctly
- [ ] Route transitions are smooth and correct
- [ ] State persistence across tabs (if expected)

---

## Section 2 — UI Audit

### 2.1 Consistency — Verify
- [ ] Consistent spacing across all views
- [ ] Consistent typography scale (headings, body, captions)
- [ ] Consistent icon sizing
- [ ] Consistent border radius
- [ ] Consistent shadows
- [ ] Consistent button styles and sizes
- [ ] Consistent colour usage (no rogue hex values)
- [ ] Consistent animation timing
- [ ] Consistent interaction states (hover, active, focus, disabled)

### 2.2 States — Inspect
- [ ] Hover states visible and correct
- [ ] Active states visible and correct
- [ ] Focus states visible and correct (not just outline: none)
- [ ] Loading states for async actions
- [ ] Disabled states for inactive controls
- [ ] Empty states for lists, tables, and data views
- [ ] Error states for form fields and failed requests

### 2.3 Visual Defects — Detect
- [ ] No overlapping elements
- [ ] No clipped or truncated text
- [ ] No overflowing containers
- [ ] No broken grid layouts
- [ ] No z-index stacking issues
- [ ] No accidental horizontal scrollbars
- [ ] No blurry or stretched images
- [ ] No inconsistent element alignment
- [ ] No pixel jumps during interaction
- [ ] No animation glitches or jank

---

## Section 3 — UX Audit

### 3.1 Analyse
- [ ] No confusing or counterintuitive flows
- [ ] No excessive clicks to complete primary tasks
- [ ] No unclear or ambiguous labels
- [ ] No weak information hierarchy
- [ ] No discoverability issues (important features hidden)
- [ ] No poor onboarding for first-time users
- [ ] No missing feedback after user actions
- [ ] No weak affordances (things that look interactive but aren't, or vice versa)
- [ ] No inconsistent interaction patterns across views
- [ ] No unnecessarily frustrating workflows

### 3.2 Verify
- [ ] Users always know what the application is doing
- [ ] Actions provide visible and understandable feedback
- [ ] Loading states communicate what is happening
- [ ] Destructive actions require confirmation
- [ ] Errors are explained in plain language with a path to recovery
- [ ] Forms are intuitive and forgiving
- [ ] Navigation is predictable and consistent

---

## Section 4 — Responsiveness Audit

### 4.1 Test These Viewports

**Mobile**
- [ ] 320px
- [ ] 360px
- [ ] 375px
- [ ] 390px
- [ ] 414px

**Tablet**
- [ ] 768px
- [ ] 820px
- [ ] 1024px

**Desktop**
- [ ] 1280px
- [ ] 1440px
- [ ] 1728px
- [ ] 1920px

### 4.2 Verify at All Viewports
- [ ] No horizontal overflow
- [ ] No hidden or inaccessible controls
- [ ] No clipped text
- [ ] Touch targets are at least 44×44px
- [ ] Navigation is usable
- [ ] Modals are usable
- [ ] Images scale correctly
- [ ] Tables are functional (scroll or reflow)
- [ ] Charts and data visualisations are readable
- [ ] Sticky elements behave correctly

### 4.3 Also Test
- [ ] Portrait mode
- [ ] Landscape mode
- [ ] Browser zoom to 200%
- [ ] Dynamic viewport resizing (drag window)
- [ ] Split-screen mode

---

## Section 5 — Accessibility Audit

### 5.1 Keyboard Navigation
- [ ] All interactive elements are reachable by Tab
- [ ] Focus states are visible on all focusable elements
- [ ] Tab order is logical and matches visual layout
- [ ] Escape closes modals, drawers, and dropdowns
- [ ] Enter and Space trigger buttons and controls
- [ ] Arrow keys work in menus, listboxes, and date pickers (where applicable)

### 5.2 Screen Reader Support
- [ ] Semantic HTML used throughout (not div-soup)
- [ ] All interactive elements have accessible labels (`aria-label` or visible text)
- [ ] Images have meaningful `alt` text (or `alt=""` for decorative)
- [ ] Heading hierarchy is logical (h1 → h2 → h3, no skips)
- [ ] Form inputs are labelled (via `<label>` or `aria-label`)
- [ ] Buttons have descriptive text (not just "Click here" or icon-only without label)
- [ ] Dynamic content updates are announced (`aria-live` where needed)
- [ ] Modal dialogs have `role="dialog"` and `aria-modal="true"`

### 5.3 Visual Accessibility
- [ ] Text contrast meets WCAG AA (4.5:1 for normal text, 3:1 for large text)
- [ ] Typography is readable at 16px base
- [ ] Font sizes scale correctly with browser zoom
- [ ] `prefers-reduced-motion` is respected (animations pause or reduce)

### 5.4 Forms Accessibility
- [ ] Validation errors are announced to screen readers
- [ ] Errors are associated to fields via `aria-describedby`
- [ ] `autocomplete` attributes are set correctly
- [ ] Placeholders are not used as the sole label

---

## Section 6 — Performance Audit

### 6.1 Analyse
- [ ] Initial page load time is acceptable (<3s on fast connection)
- [ ] JavaScript bundle size is reasonable (check for unnecessary libraries)
- [ ] CSS bundle size is reasonable
- [ ] Assets are properly optimised (images, fonts)
- [ ] Images use correct formats (WebP or AVIF preferred)
- [ ] Lazy loading is applied to off-screen images and components
- [ ] Render performance is smooth (no jank on scroll or interaction)
- [ ] Memory usage does not grow unboundedly during use
- [ ] CPU usage is reasonable under normal interaction
- [ ] Network waterfall shows no unnecessary blocking

### 6.2 Detect
- [ ] No unnecessary component re-renders
- [ ] No render-blocking scripts in `<head>`
- [ ] No duplicate dependencies in bundle
- [ ] No render thrashing (forced layout/reflow in JS loops)
- [ ] No excessive DOM updates
- [ ] No large uncompressed payloads
- [ ] No expensive animations running on main thread

### 6.3 Simulate
- [ ] Slow 3G network profile
- [ ] Offline mode
- [ ] 6x CPU throttling
- [ ] Low memory device simulation

---

## Section 7 — Frontend Code Audit

### 7.1 Detect
- [ ] Dead code (unused components, functions, imports)
- [ ] Duplicated components serving the same purpose
- [ ] Duplicated styles (same CSS written in multiple places)
- [ ] Giant components (doing too much, should be split)
- [ ] Hardcoded values that should be constants or config
- [ ] Magic numbers with no explanation
- [ ] Unnecessary state (derived values stored as state)
- [ ] Unnecessary effects (logic that belongs elsewhere)
- [ ] Unnecessary re-renders caused by unstable references
- [ ] Deeply nested conditional logic
- [ ] Prop drilling through many layers (consider context or state management)
- [ ] Weak or misleading naming (variables, components, functions)

### 7.2 Verify
- [ ] Reusable and composable architecture
- [ ] Maintainable and readable code structure
- [ ] Scalable patterns used consistently
- [ ] Separation of concerns (UI, logic, data)
- [ ] Consistent code style across files
- [ ] Modular file structure

---

## Section 8 — Backend Audit

### 8.1 Verify
- [ ] Authentication is enforced on all protected routes
- [ ] Authorisation checks are enforced (not just authenticated, but permitted)
- [ ] Input validation on all endpoints
- [ ] Input sanitisation before processing or storage
- [ ] Caching is implemented where appropriate
- [ ] Rate limiting is in place
- [ ] Pagination is implemented for list endpoints
- [ ] Retry handling for transient failures
- [ ] Timeout handling on all external requests
- [ ] Logging is structured and sufficient for debugging
- [ ] Monitoring and alerting is configured
- [ ] Queue handling for long-running operations

### 8.2 Detect
- [ ] N+1 query patterns
- [ ] Duplicated or redundant queries
- [ ] Slow endpoints (>500ms for simple reads)
- [ ] Exposed secrets in responses or logs
- [ ] Insecure or unauthenticated endpoints
- [ ] Poor schema design
- [ ] Missing database indexes on frequently queried fields

---

## Section 9 — Database Audit

### 9.1 Analyse
- [ ] Schema design is clean and normalised appropriately
- [ ] Query performance is acceptable under realistic load
- [ ] Indexing strategy is sound
- [ ] Migrations are reversible and safe
- [ ] Schema can scale with data growth
- [ ] Consistency and integrity constraints are in place

### 9.2 Detect
- [ ] Orphaned records (no referential integrity)
- [ ] Duplicated data that should be normalised
- [ ] Bad or missing foreign key relationships
- [ ] Missing NOT NULL or UNIQUE constraints
- [ ] Poor indexing on join or filter columns
- [ ] Redundant or unused fields

---

## Section 10 — Security Audit

### 10.1 Test
- [ ] XSS: inject `<script>alert(1)</script>` into all inputs
- [ ] CSRF: verify tokens are present on state-changing requests
- [ ] SQL injection: test `' OR 1=1 --` and similar strings in inputs
- [ ] Auth bypass: attempt to access protected routes without a session
- [ ] Privilege escalation: attempt to access other users' data
- [ ] Token leakage: check localStorage, sessionStorage, URL params for tokens
- [ ] Insecure cookies: verify `HttpOnly`, `Secure`, `SameSite` flags
- [ ] Insecure local storage: tokens should not be stored in localStorage
- [ ] Unrestricted file uploads: check file type and size validation
- [ ] Clickjacking: verify `X-Frame-Options` or `frame-ancestors` CSP
- [ ] Open redirects: test `?redirect=https://evil.com`
- [ ] Brute force: verify account lockout or rate limiting on login
- [ ] Rate limit bypass: test with varied IPs/headers

### 10.2 Verify
- [ ] HTTPS enforced everywhere
- [ ] Content Security Policy (CSP) header present
- [ ] `Strict-Transport-Security` header present
- [ ] `X-Content-Type-Options: nosniff` present
- [ ] `X-Frame-Options` or CSP `frame-ancestors` set
- [ ] Input sanitised before rendering
- [ ] Proper permission model enforced on all resources
- [ ] Secrets in environment variables, not source code

---

## Section 11 — SEO Audit

### 11.1 Verify
- [ ] Unique `<title>` tag on every page
- [ ] `<meta name="description">` on every page
- [ ] Semantic HTML used for content (article, main, nav, etc.)
- [ ] Heading hierarchy is correct (one h1 per page)
- [ ] Canonical URLs set where needed
- [ ] Structured data (JSON-LD) on applicable pages
- [ ] Open Graph tags (og:title, og:description, og:image)
- [ ] Twitter Card meta tags
- [ ] `sitemap.xml` exists and is up to date
- [ ] `robots.txt` exists and is correct

### 11.2 Detect
- [ ] Duplicate or missing meta titles/descriptions
- [ ] Pages blocked from indexing unintentionally
- [ ] Duplicate content across routes

---

## Section 12 — Forms Audit

### 12.1 Test These Inputs
- [ ] Empty submission
- [ ] Invalid email address format
- [ ] Invalid phone number format
- [ ] Extremely long input (1000+ characters)
- [ ] Special characters (`!@#$%^&*()`)
- [ ] Emoji input (🎉🔥)
- [ ] SQL injection strings (`'; DROP TABLE users; --`)
- [ ] XSS payloads (`<img src=x onerror=alert(1)>`)
- [ ] Rapid repeated submission (double-click, spam)

### 12.2 Verify
- [ ] Inline validation appears as the user types or on blur
- [ ] Server-side validation is also present (never trust client only)
- [ ] Error messages are clear and actionable
- [ ] Success messages confirm the action completed
- [ ] Form state is preserved on validation failure (don't reset the form)

---

## Section 13 — Data Audit

### 13.1 Verify
- [ ] Data renders accurately (matches API response)
- [ ] Sorting works correctly (including edge cases: nulls, ties)
- [ ] Filtering produces correct results
- [ ] Pagination is correct (no skipped or duplicated records)
- [ ] Number formatting is correct (locale, decimal places)
- [ ] Date/time formatting is correct and timezone-aware
- [ ] Currency is formatted correctly
- [ ] Stale data is not shown after mutations

### 13.2 Detect
- [ ] Duplicated records in lists
- [ ] Inconsistent state between views
- [ ] Cache/UI desync after updates
- [ ] Incorrect calculations or totals

---

## Section 14 — Error Handling Audit

### 14.1 Force These Errors
- [ ] Block all API requests (via DevTools) and observe behaviour
- [ ] Navigate to a non-existent route
- [ ] Send malformed data to the API
- [ ] Simulate offline mode
- [ ] Simulate a request timeout
- [ ] Simulate a 500 server error

### 14.2 Verify
- [ ] Graceful recovery (app does not crash)
- [ ] Retry mechanisms are present where appropriate
- [ ] Error messages are user-friendly (no stack traces to end users)
- [ ] Fallback UI is shown when data cannot load
- [ ] Errors are logged correctly for debugging

---

## Section 15 — Animation Audit

### 15.1 Verify
- [ ] Animations are smooth (60fps target)
- [ ] No frame drops during complex animations
- [ ] Timing feels natural (not too fast or too slow)
- [ ] `prefers-reduced-motion` disables or reduces animations

### 15.2 Detect
- [ ] Excessive or distracting animations
- [ ] Animations that block user interaction
- [ ] Inconsistent timing across similar transitions

---

## Section 16 — State Management Audit

### 16.1 Detect
- [ ] Stale state shown after data mutations
- [ ] Duplicated state (same data stored in multiple places)
- [ ] Race conditions from concurrent async operations
- [ ] Memory leaks from unsubscribed listeners or intervals
- [ ] Sync issues between global and local state
- [ ] Unnecessary global state (data that should be local)

---

## Section 17 — Routing Audit

### 17.1 Verify
- [ ] Deep links work (paste URL directly in browser)
- [ ] Page refresh on any route works correctly
- [ ] Back and forward browser buttons behave correctly
- [ ] Redirects work as expected
- [ ] Protected routes redirect unauthenticated users
- [ ] 404 page exists and is helpful
- [ ] Route guards prevent unauthorised access

---

## Section 18 — Offline Audit

### 18.1 Test
- [ ] Behaviour when network is disconnected
- [ ] Behaviour when network reconnects
- [ ] Cached assets load correctly while offline
- [ ] Fallback UI is shown when content cannot load
- [ ] Service worker (if present) handles offline correctly

---

## Section 19 — DevOps Audit

### 19.1 Verify
- [ ] Production config is separate from development
- [ ] Environment variables are used for all environment-specific values
- [ ] No secrets committed to source control
- [ ] CI/CD pipeline runs tests before deployment
- [ ] Rollback strategy exists and is documented
- [ ] Monitoring and alerting are configured for production
- [ ] Structured logging is in place
- [ ] Backups are configured for the database
- [ ] Build output is optimised (minified, tree-shaken)

---

## Section 20 — Architecture Audit

### 20.1 Analyse
- [ ] System can scale horizontally
- [ ] Separation of concerns is maintained
- [ ] Modules are loosely coupled
- [ ] System is maintainable by a new engineer without extensive hand-holding
- [ ] Future feature additions are unobstructed by current architecture

### 20.2 Detect
- [ ] Technical debt that will compound
- [ ] Overengineering (complexity beyond what the problem demands)
- [ ] Underengineering (shortcuts that will break at scale)
- [ ] Bottlenecks (single points of failure or performance)

---

## Section 21 — Redundancy Audit

### 21.1 Detect
- [ ] Duplicated business logic in multiple places
- [ ] Duplicated API endpoints doing the same thing
- [ ] Duplicated UI components that should be unified
- [ ] Duplicated CSS/style definitions
- [ ] Duplicate network requests for the same data
- [ ] Unnecessary abstractions adding complexity without benefit
- [ ] Unnecessary third-party dependencies

---

## Section 22 — Browser Compatibility Audit

### 22.1 Test In
- [ ] Chrome (latest)
- [ ] Safari (latest)
- [ ] Firefox (latest)
- [ ] Edge (latest)

### 22.2 Verify
- [ ] Layout is consistent across all browsers
- [ ] Features degrade gracefully in older browsers
- [ ] Touch events work correctly on mobile browsers

---

## Section 23 — Real-Time Application Audit

*(Skip if the application has no real-time features.)*

### 23.1 Verify
- [ ] Polling is stable and does not grow unboundedly
- [ ] WebSocket connections are stable and reconnect cleanly
- [ ] Subscriptions are cleaned up on component unmount
- [ ] Stale data is not shown after reconnection
- [ ] Events are not duplicated on reconnect
- [ ] Throttling prevents event floods

### 23.2 Detect
- [ ] Memory leaks from uncleared subscriptions
- [ ] Duplicate event handling
- [ ] Race conditions in concurrent updates
- [ ] Stale or zombie subscriptions

---

## Section 24 — Maps & Geolocation Audit

*(Skip if the application has no maps or geolocation features.)*

### 24.1 Verify
- [ ] Geolocation permission is requested correctly
- [ ] Fallback behaviour when permission is denied
- [ ] Map renders correctly at all zoom levels
- [ ] Markers render correctly
- [ ] Routes render correctly
- [ ] Mobile pinch-to-zoom and pan gestures work
- [ ] Marker clustering performs well at high data volumes
- [ ] GPS accuracy edge cases are handled

### 24.2 Detect
- [ ] Stale position data
- [ ] Jittery marker movement
- [ ] Memory leaks from map instances
- [ ] Excessive polling for location updates

---

## Section 25 — API Integration Audit

### 25.1 Verify
- [ ] Failed requests are retried with appropriate backoff
- [ ] Requests have timeout handling
- [ ] Stale cache is invalidated after mutations
- [ ] Duplicate requests are deduplicated (debounce/throttle)
- [ ] Pagination is handled correctly (no missing or duplicate pages)
- [ ] Optimistic updates are rolled back on failure

### 25.2 Detect
- [ ] Overfetching (requesting more data than needed)
- [ ] Underfetching (requiring multiple requests where one would do)
- [ ] Duplicate requests firing simultaneously
- [ ] Inconsistent API response handling

---

## Section 26 — Mobile Experience Audit

### 26.1 Verify
- [ ] Touch responses feel immediate (no perceptible delay)
- [ ] Swipe and gesture interactions work correctly
- [ ] All tap targets are at least 44×44px
- [ ] Virtual keyboard does not obscure input fields
- [ ] Viewport does not zoom unintentionally on input focus
- [ ] Safe area insets are respected (notch, home indicator)
- [ ] Scroll behaviour is natural and correct

### 26.2 Detect
- [ ] Scroll locking issues
- [ ] Content hidden behind virtual keyboard
- [ ] Accidental pinch-to-zoom on inputs
- [ ] Touch delay on interactive elements
- [ ] Content overflowing safe area

---

## Section 27 — Production Readiness Audit

### 27.1 Verify
- [ ] No `console.log` or debug output in production build
- [ ] No hardcoded test credentials or API keys
- [ ] No development banners or debug overlays
- [ ] No broken analytics or tracking
- [ ] Error reporting (e.g. Sentry) is configured
- [ ] Production build optimisations are enabled (minification, tree-shaking)
- [ ] Feature flags are correctly configured for production

---

## Section 28 — Scalability Audit

### 28.1 Analyse
- [ ] Application is ready for horizontal scaling
- [ ] Database can scale with data and traffic growth
- [ ] Caching strategy is appropriate
- [ ] Long-running operations are handled asynchronously
- [ ] Message queues are used where appropriate
- [ ] No infrastructure bottlenecks that will fail under load

---

## Section 29 — AI-Specific Code Audit

*(Relevant for codebases with significant AI-generated or AI-assisted code.)*

### 29.1 Detect
- [ ] Duplicated logic introduced by separate AI generation sessions
- [ ] Inconsistent coding style across AI-generated sections
- [ ] Hallucinated or non-existent library references
- [ ] Overcomplicated abstractions that solve non-existent problems
- [ ] Unnecessary dependencies introduced without justification
- [ ] Dead or unreachable code left from generation artefacts
- [ ] Generated code that contradicts project conventions

---

## Section 30 — Completion Gate (Prove The Audit Is Done)

> Do not produce the summary until this gate is satisfied. This is what stops the audit ending early with sections silently skipped.

### 30.1 Inventory Coverage (prove no area was skipped)
This is the check that prevents "whole areas never looked at." Using the inventories from Section D, account for **every item** — not a sample. Reproduce and complete:

```
SCREENS (from D.1) — every screen examined for UI, UX, responsive, a11y, behaviour?
| Screen | UI | UX | Responsive | A11y | Behaviour | Notes/Issues |
|--------|----|----|-----------|------|-----------|--------------|
| (one row per screen in D.1) | | | | | | |

WORKFLOWS (from D.3) — every workflow traced end-to-end (Section A)?
| Workflow | Traced fully? | Propagation gaps found | Notes |
|----------|---------------|------------------------|-------|
| (one row per workflow in D.3) | | | |

ENTITIES (from D.4) — every entity audited for integrity & business rules?
| Entity | Data integrity | Business rules | Notes |
|--------|----------------|----------------|-------|
| (one row per entity in D.4) | | | |
```

If any row is blank or unchecked, the audit is not complete. Every screen, workflow, and entity discovered in Section D must appear here with a result.

### 30.2 Section Coverage Tracker
Reproduce this table, marking each section. **Done** only with evidence; **Unverified** must state why; **N/A** must state why it doesn't apply.

```
| Section | Status (Done / Unverified / N/A) | Evidence or reason |
|---------|----------------------------------|--------------------|
| D — Discovery & Inventory       |  |  |
| A — Workflow & Propagation      |  |  |
| B — Business Logic & Integrity  |  |  |
| C — Cross-Cutting Consistency   |  |  |
| E — Expected Capabilities       |  |  |
| 1 — General Application         |  |  |
| 2 — UI                          |  |  |
| 3 — UX                          |  |  |
| 4 — Responsiveness              |  |  |
| 5 — Accessibility               |  |  |
| 6 — Performance                 |  |  |
| 7 — Frontend Code               |  |  |
| 8 — Backend                     |  |  |
| 9 — Database                    |  |  |
| 10 — Security                   |  |  |
| 11 — SEO                        |  |  |
| 12 — Forms                      |  |  |
| 13 — Data                       |  |  |
| 14 — Error Handling             |  |  |
| 15 — Animation                  |  |  |
| 16 — State Management           |  |  |
| 17 — Routing                    |  |  |
| 18 — Offline                    |  |  |
| 19 — DevOps                     |  |  |
| 20 — Architecture               |  |  |
| 21 — Redundancy                 |  |  |
| 22 — Browser Compatibility      |  |  |
| 23 — Real-Time                  |  |  |
| 24 — Maps & Geolocation         |  |  |
| 25 — API Integration            |  |  |
| 26 — Mobile Experience          |  |  |
| 27 — Production Readiness        |  |  |
| 28 — Scalability                |  |  |
| 29 — AI-Specific Code           |  |  |
```

### 30.3 Adversarial Final Pass
- [ ] I re-examined my own conclusions as a hostile reviewer and could not find a new issue
- [ ] Every "no issue found" section was actually inspected, not skipped
- [ ] Every screen in D.1 appears in the inventory coverage table with a result
- [ ] Every workflow in D.3 was traced to its end, with no missing propagation
- [ ] Every entity in D.4 was checked for integrity and business rules
- [ ] Section E was run: for every trigger present (data, accounts, config, notifications, tenancy), the expected capabilities were checked and any missing ones logged as findings
- [ ] Every behaviour/visual/interaction check is tagged [ran] or [test] — or marked Unverified if I could only read code
- [ ] Every Unverified item is listed with the reason it could not be verified

### 30.4 The audit is complete only when
- [ ] Section D inventories were produced and every item is accounted for in 30.1
- [ ] Every section is marked Done, Unverified (with reason), or N/A (with reason) — no blanks
- [ ] Every issue found has a full report (Section 0 template)
- [ ] The adversarial final pass found nothing new

Only now produce the summary below.

---

## Audit Output Format

When your audit is complete, produce a summary in the following format:

```
# Audit Summary

## Stats
- Total issues found: [N]
- Critical: [N]
- High: [N]
- Medium: [N]
- Low: [N]

## Critical Issues (fix immediately)
[List issue titles]

## High Priority Issues (fix before next release)
[List issue titles]

## Medium Priority Issues (fix in next sprint)
[List issue titles]

## Low Priority Issues (fix when time allows)
[List issue titles]

## Sections with No Issues Found
[List clean sections]

## Unverified Items (could not be confirmed)
[List any checks you could not verify, each with the reason]

## Coverage Confirmation
[Confirm every screen (D.1), workflow (D.3), and entity (D.4) was examined per the 30.1 tables, and that all sections D, A, B, C, 1–29 are Done / N/A. List any gaps.]

## Recommended Priority Order
1. [Most urgent fix]
2. [Second most urgent]
...
```

---

*AUDIT.md — AI System Audit Framework · Use with Claude Code for VSCode*
