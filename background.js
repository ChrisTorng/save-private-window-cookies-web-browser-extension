// Chromium MV3 implementation: event listeners are registered synchronously.
// Incognito cookies are intentionally stored locally in the regular extension profile.
let restoring = false;
let saveQueue = Promise.resolve();

async function privateWindows() {
  return (await chrome.windows.getAll({populate: true})).filter(w => w.incognito);
}

async function privateStoreId() {
  const windows = await privateWindows();
  if (!windows.length) return null;
  const ids = new Set(windows.flatMap(w => (w.tabs || []).map(t => t.id)));
  const stores = await chrome.cookies.getAllCookieStores();
  const match = stores.find(store => store.tabIds.some(id => ids.has(id)));
  return match ? match.id : null;
}

function cookieUrl(cookie) {
  return (cookie.secure ? 'https://' : 'http://') +
    cookie.domain.replace(/^\\./, '') + (cookie.path || '/');
}

function cookieSetDetails(cookie, storeId) {
  const details = {
    url: cookieUrl(cookie), name: cookie.name, value: cookie.value,
    path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite, storeId
  };
  // Omitting domain preserves host-only cookies.
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (!cookie.session && typeof cookie.expirationDate === 'number') {
    details.expirationDate = cookie.expirationDate;
  }
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  return details;
}

async function recordStatus(status) {
  await chrome.storage.local.set({last_status: status});
}

async function saveSnapshot() {
  if (restoring) return;
  const {auto_save = false} = await chrome.storage.local.get({auto_save: false});
  if (!auto_save || restoring) return;
  const storeId = await privateStoreId();
  if (!storeId || restoring) return;
  const cookies = await chrome.cookies.getAll({storeId});
  if (restoring) return;
  // Never replace a good snapshot with an unexplained empty result.
  const previous = await chrome.storage.local.get('cookies');
  if (!cookies.length && (previous.cookies || []).length) {
    await recordStatus({operation: 'save', error: 'Skipped empty snapshot', time: Date.now()});
    return;
  }
  await chrome.storage.local.set({
    cookies, last_status: {operation: 'save', count: cookies.length, time: Date.now(), storeId}
  });
}

function queueSave() {
  saveQueue = saveQueue.then(saveSnapshot).catch(async e => {
    await recordStatus({operation: 'save', error: String(e), time: Date.now()});
  });
}

async function restoreSnapshot() {
  const storeId = await privateStoreId();
  if (!storeId) {
    await recordStatus({operation: 'restore', error: 'No InPrivate cookie store', time: Date.now()});
    return;
  }
  const {cookies = []} = await chrome.storage.local.get({cookies: []});
  if (!cookies.length) {
    await recordStatus({operation: 'restore', error: 'No saved cookies', time: Date.now()});
    return;
  }
  restoring = true;
  let ok = 0, failed = 0;
  const errors = [];
  try {
    for (const cookie of cookies) {
      try {
        const result = await chrome.cookies.set(cookieSetDetails(cookie, storeId));
        if (result) ok++;
        else {failed++; errors.push(cookie.domain + ': empty result');}
      } catch (e) {
        failed++;
        if (errors.length < 8) errors.push(cookie.domain + ': ' + String(e));
      }
    }
    await recordStatus({
      operation: 'restore', time: Date.now(), storeId, total: cookies.length,
      restored: ok, failed, errors
    });
  } finally {
    restoring = false;
  }
}

// MV3: NEVER register cookie-change listeners in a Promise callback or
// conditional branch. The worker is stopped and started repeatedly.
chrome.cookies.onChanged.addListener(change => {
  if (restoring || change.cause === 'overwrite') return;
  queueSave();
});

chrome.windows.onCreated.addListener(async window => {
  if (!window.incognito) return;
  try {
    if (!await chrome.extension.isAllowedIncognitoAccess()) return;
    // Restore once when the first InPrivate window opens, not on every window.
    const windows = await privateWindows();
    if (windows.length === 1) await restoreSnapshot();
  } catch (e) {
    await recordStatus({operation: 'restore', error: String(e), time: Date.now()});
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(async () => {
  const {auto_save = false} = await chrome.storage.local.get({auto_save: false});
  await chrome.storage.local.set({auto_save});
});
