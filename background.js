// Edge/Chromium MV3. No remote endpoints; cookie data stays in chrome.storage.local.
// Listeners MUST be registered synchronously at the service-worker top level.
let initializing = null;
let saveQueue = Promise.resolve();

async function privateStore() {
  const windows = (await chrome.windows.getAll({populate:true})).filter(w => w.incognito);
  const tabIds = new Set(windows.flatMap(w => (w.tabs || []).map(t => t.id)));
  if (!tabIds.size) return null;
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find(s => s.tabIds.some(id => tabIds.has(id)))?.id ?? null;
}
function urlFor(c) {
  const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  return (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
}
function toSet(c, storeId) {
  const d = {url:urlFor(c), storeId, name:c.name, value:c.value,
    path:c.path || '/', secure:c.secure, httpOnly:c.httpOnly, sameSite:c.sameSite};
  if (!c.hostOnly) d.domain = c.domain;
  if (!c.session && typeof c.expirationDate === 'number') d.expirationDate = c.expirationDate;
  if (c.partitionKey) d.partitionKey = c.partitionKey;
  return d;
}
function cookieKey(c) {
  return JSON.stringify([c.domain, c.path, c.name, c.partitionKey || null]);
}
async function restoreCookies(cookies, storeId) {
  let written=0, failed=0, expired=0;
  const errors=[];
  for (const c of cookies) {
    if (c.expirationDate && c.expirationDate <= Date.now()/1000) {expired++; continue;}
    try {
      const result=await chrome.cookies.set(toSet(c,storeId));
      if (result) written++;
      else {failed++; if(errors.length<10) errors.push(c.domain+' / '+c.name+': no result');}
    } catch(e) {
      failed++;
      if(errors.length<10) errors.push(c.domain+' / '+c.name+': '+String(e));
    }
  }
  // Immediately read the target cookie store back; no values appear in logs.
  const after=await chrome.cookies.getAll({storeId});
  const byKey=new Map(after.map(c=>[cookieKey(c),c]));
  let verified=0, mismatched=0;
  for(const c of cookies) {
    if(c.expirationDate && c.expirationDate<=Date.now()/1000) continue;
    const got=byKey.get(cookieKey(c));
    if(got && got.value===c.value) verified++;
    else {mismatched++; if(errors.length<10) errors.push(c.domain+' / '+c.name+': readback mismatch');}
  }
  return {total:cookies.length, written, verified, failed, expired, mismatched, errors};
}
async function record(status) {
  await chrome.storage.local.set({last_status:{...status,time:Date.now()}});
}
async function initializePrivate() {
  const {privateInit=false}=await chrome.storage.session.get({privateInit:false});
  if (privateInit) return;
  const storeId=await privateStore();
  if (!storeId) return; // window-created can fire before the first tab exists
  await chrome.storage.session.set({privateInit:true,privateRestoring:true});
  try {
    const {cookies=[]}=await chrome.storage.local.get({cookies:[]});
    if(cookies.length) await record({operation:'automatic restore',storeId,
      ...await restoreCookies(cookies,storeId)});
    else await record({operation:'automatic restore',storeId,error:'No saved cookie snapshot'});
  } catch(e) {
    await record({operation:'automatic restore',storeId,error:String(e)});
  } finally {
    await chrome.storage.session.set({privateRestoring:false});
  }
}
function ensurePrivateInitialized() {
  if(!initializing) initializing=initializePrivate().finally(()=>{initializing=null;});
  return initializing;
}
async function saveSnapshot(changedStoreId) {
  const {auto_save=false}=await chrome.storage.local.get({auto_save:false});
  if(!auto_save) return;
  const state=await chrome.storage.session.get({privateInit:false,privateRestoring:false});
  if(!state.privateInit || state.privateRestoring) return;
  const storeId=await privateStore();
  if(!storeId || (changedStoreId && changedStoreId!==storeId)) return;
  const cookies=await chrome.cookies.getAll({storeId});
  const {cookies:old=[]}=await chrome.storage.local.get({cookies:[]});
  if(!cookies.length && old.length) {
    await record({operation:'automatic save',error:'Skipped empty snapshot'});
    return;
  }
  await chrome.storage.local.set({cookies,last_status:{
    operation:'automatic save',count:cookies.length,storeId,time:Date.now()}});
}
function scheduleSave(storeId) {
  saveQueue=saveQueue.then(()=>saveSnapshot(storeId)).catch(e=>record({
    operation:'automatic save',error:String(e)}));
}
chrome.cookies.onChanged.addListener(change=>{
  // The store ID is checked within saveSnapshot; never inspect other-profile cookies.
  scheduleSave(change.cookie.storeId);
});
chrome.windows.onCreated.addListener(w=>{
  if(w.incognito) void ensurePrivateInitialized();
});
chrome.tabs.onCreated.addListener(tab=>{
  if(tab.incognito) void ensurePrivateInitialized();
});
chrome.tabs.onUpdated.addListener((_tabId,_change,tab)=>{
  if(tab.incognito) void ensurePrivateInitialized();
});
chrome.windows.onRemoved.addListener(async()=>{
  if(!(await chrome.windows.getAll()).some(w=>w.incognito)) {
    await chrome.storage.session.remove(['privateInit','privateRestoring']);
  }
});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(async()=>{
  const {auto_save=false}=await chrome.storage.local.get({auto_save:false});
  await chrome.storage.local.set({auto_save});
});
