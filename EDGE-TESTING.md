# Edge MV3 diagnostic build (v1.3.2)

**Purpose:** distinguish Cookie API failures from websites that authenticate using other
storage or memory. Does **not** capture Discord authentication tokens or localStorage.

## Install in Edge

1. Download the ZIP using **Code → Download ZIP** from the branch
   `fix/edge-incognito-mv3`. Extract to a permanent location.
2. In `edge://extensions`, disable the old store-installed extension, so two
   extensions don't concurrently overwrite cookies. Enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing
   `manifest.json` and `background.js`. The fork's `manifest.json` is
   now an Edge-compatible MV3 file; original Firefox manifest is preserved as
   `manifest-firefox.json`.
4. In **Details**, enable **Allow in InPrivate**. Open an InPrivate tab and
   the extension's **Extension options**.
5. On a non-sensitive test site, **Save live cookies now**, then
   **Verify saved vs live cookies** (expected missingOrChanged=0).
6. Close all InPrivate windows, reopen one, and inspect the **automatic restore**
   result: written, verified, failed and mismatched. Click Verify again before
   navigating to other sites.
7. Reopen/refresh the website and assess sign-in **separately** from cookie
   readback. Even perfect readback cannot guarantee login.

## Meaning of controls

- **Save live cookies now**: captures current InPrivate cookie store.
- **Export backup JSON (refresh first)**: captures live cookies when possible
  and exports saved snapshot as JSON. This JSON may contain account credentials!
- **Restore saved cookies**: manual restore of the stored snapshot without importing.
- **Import backup JSON and restore**: accepts backup from the original extension.
- **Verify saved vs live**: compares keys and values in memory, reports *counts*
  and cookie domain/name only, never actual values.

## Technical details

- MV3 event listeners are registered synchronously at service-worker top level.
- `chrome.storage.session` records whether the current InPrivate lifecycle was
  initialized, and cookie change auto-saving is skipped during restoration.
- The first tab creation can follow the first InPrivate window creation.
  Both events trigger initialization so an empty cookie store is not mistaken
  for an error.
- `cookie.storeId` is determined from `getAllCookieStores`, not hardcoded `'1'`.
- Domain leading period is stripped only from the URL, not from domain-scoped
  cookies; hostOnly and SameSite information is retained.
- Await `cookies.set` and immediately check readback to report partial failures.
- Only unpartitioned cookies can be enumerated without known partition keys.
- Cookies are stored *unencrypted* in extension local storage; OS agents can
  still monitor the host and network.
- Static code changes have not been validated in a live local Edge session.

## Troubleshooting

- If the extension shows **No InPrivate cookie store**, keep at least one
  InPrivate tab open and reload Options.
- If `failed > 0`, copy only redacted error messages (never Cookie values).
- If `verified == total - expired` but the site is still logged out, that
  site is not restorable with Cookie-only backup. For Discord, this is expected.
- If `auto_save` overwrites your old good snapshot, use **Import backup JSON**
  and disable automatic saving while investigating.
