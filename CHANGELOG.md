# Changelog

All notable changes to the Solatide store (backend + admin hub + storefront).
The Server and Client repos are released **together with the same version number**; this file is
kept identical in both.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versions: [Semantic Versioning](https://semver.org/) — `MAJOR.MINOR.PATCH`

- **PATCH** (1.5.0 → 1.5.1): bug fixes only
- **MINOR** (1.5.0 → 1.6.0): new features, nothing breaks
- **MAJOR** (1.x → 2.0.0): breaking change (e.g. data migration required, removed feature/API)

---

## How to release

Do this in **both** repos (Server and Client), on the branch being deployed (normally `main`):

1. Move the items from **Unreleased** into a new version section below, with today's date.
2. Bump the version (updates `package.json` + `package-lock.json`; no commit, no tag):
   ```bash
   npm version minor --no-git-tag-version   # or: patch / major
   ```
3. Copy the updated `CHANGELOG.md` to the other repo, so both match.
4. Commit, then tag the exact commit that is deployed and push the tag:
   ```bash
   git commit -am "release: v1.6.0"
   git tag -a v1.6.0 -m "v1.6.0 – <one-line summary>"
   git push && git push origin v1.6.0
   ```
5. Deploy. Check the live version: the server logs `Solatide API v<version> (<commit>)` at startup,
   and a logged-in admin can open `/api/admin/version`.
6. Send the client the new section of this file as the release note.

Handy:
```bash
git tag --sort=-creatordate | head      # releases, newest first
git diff v1.5.0 v1.6.0 --stat           # what changed between two releases
git checkout v1.5.0                     # exactly what was live in 1.5.0 (e.g. to roll back)
```
If the server folder is not a git checkout, set `APP_COMMIT=<commit>` in the deploy so the
commit is still shown.

---

## [Unreleased]

Nothing yet.

---

## [1.6.0] — 2026-11-27

Branch `fix/admin-critical-bugs` (1.5.0 + Analytics Milestone 3 + admin fixes).

### Added
- **Visitor panel (M3)** — Journey, Current cart, Previous sessions and Visitor details tabs;
  switch visitors inside the panel; one card per visitor.
- **Storefront updates card** (Settings → Store) — website rebuild status, "Rebuild now" button;
  admins are emailed when a rebuild fails (max once an hour) and when it works again.
- "Make this the current batch" option on batches.
- "Cancel & release stock" for unpaid manual orders.
- **Order Request checkout is now fully tracked** (the live checkout mode): checkout steps
  (Information / Shipping) and errors are recorded; a sent request shows as "Order request sent"
  (with its REQ reference) on the live card, feed and visitor panel; the visitor is named; the cart
  shows as emptied; the checkout is closed as submitted, so it is never counted as abandoned. The
  order the admin creates from a request joins that visit, so "Payment confirmed" appears there too.
- Visitor panel → Visitor details: visit (session) ID, referrer, UTM tags and ad click type, and a
  "View customer" link when the visitor's email matches a customer record.

### Changed
- Product page QC "Test Summary": equal-size cards; long results end with "…" and show in full on
  hover/tap.
- Imported reviews and CMS page changes always refresh the website; returned stock only rebuilds
  the website when a sold-out item comes back in stock.

### Fixed
- Order page "Refund Full Amount" failed for every order.
- Editing a customer's name/email/phone on an order was not saved.
- Saving a product could overwrite live stock with the number from when the page was opened.
- Editing a batch (or removing its COA) made it the product's current batch.
- FAQ "hidden" questions became visible again after saving.
- Cancelling/deleting an unpaid manual order did not return its stock.
- Banned customers could still check out / send order requests.

---

## [1.5.0] — 2026-11-26

Branch `feat/starshipit-duplicate-alert` (built on 1.4.0).

### Added
- **Duplicate shipping-label alert** — order page warning, admin email and a daily check when
  Starshipit shows a second label or tracking number for an order; "Mark as resolved".
- Live view: a visit that opens an order's payment link in another browser (e.g. from the payment
  email) now shows the customer's name — linked by the order's secret link, never by guessing; the
  order is not counted twice.
- Analytics: visits from our emails show source **"Email"** (links in payment, reminder, order
  confirmation, shipping, welcome and abandoned-checkout emails carry UTM tags).
- Running version available to staff at `GET /api/admin/version` (not shown in the UI).

### Changed
- Live view: visitors in the Google app's built-in browser show as **"Google app"** (was "Safari").
- "Active now": heartbeat every 15 s (was 30 s) and active window 40 s (was 75 s), so a closed tab
  whose "left" signal never arrived turns inactive about twice as fast.
  `ANALYTICS_ACTIVE_SECONDS` default is now 40 — check the live `.env` does not still set 75.

### Fixed
- A closed tab could keep showing "Active now" because requests sent as the tab closed were handled
  out of order; a visitor returning to the tab could likewise be marked as gone.
- Label purchase: Starshipit "label already generated elsewhere" (MyPost 51015) is reported clearly
  and never retried.
- Review verification email logo was loaded from imgur; now Solatide's own image.

---

## [1.4.0] — replaced by 1.5.0

First versioned release: everything live before versioning started.

- M1 tracking foundation (visitors, sessions, checkout tracking, location by IP).
- M2 live view (visitor cards, All activity feed, slide-in visitor panel) and Live Store View.
- Bank transfer / PayID and Order Request checkout; TagadaPay removed.
- Orders, Starshipit shipping labels and tracking, products, batches/COAs, collections, discounts,
  customers, CMS pages, FAQs, homepage editor, redirects, reviews, admin users and settings.
