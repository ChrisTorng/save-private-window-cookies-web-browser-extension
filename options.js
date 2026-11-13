const $ = id => document.getElementById(id);
let downloadId, objectUrl;

function cookieUrl(c) {
  return (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\\./, '') + (c.path || '/');
}
async function privateStoreId() {
  const windows = (await chrome.windows.getAll({populate:true})).filter(w => w.incognito);
  if (!windows.length) return null;
  const ids = new Set(windows.flatMap(w => (w.tabs || []).map(t => t.id)));
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find(s => s.tabIds.some(id => ids.has(id)))?.id || null;
}
function setDetails(c, storeId) {
  const d = {url:cookieUrl(c), name:c.name, value:c.value, path:c.path,
    secure:c.secure, httpOnly:c.httpOnly, sameSite:c.sameSite, storeId};
  if (!c.hostOnly) d.domain = c.domain;
  if (!c.session && typeof c.expirationDate === 'number') d.expirationDate = c.expirationDate;
  if (c.partitionKey) d.partitionKey = c.partitionKey;
  return d;
}
async function refresh() {
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  const access = await chrome.permissions.contains({origins:['<all_urls>']});
  const storeId = allowed ? await privateStoreId() : null;
  const {auto_save = false, cookies = [], last_status} =
    await chrome.storage.local.get({auto_save:false, cookies:[]});
  $('auto_save').checked = auto_save;
  $('auto_save').disabled = !(allowed && access);
  $('save').disabled = !(allowed && access && storeId);
  $('backup').disabled = !cookies.length;
  $('delete').disabled = !cookies.length;
  $('warning').textContent = !allowed ? 'Enable Allow in InPrivate in Edge extension details.' :
    !access ? 'Enable site access on all websites.' :
    !storeId ? 'No InPrivate cookie store detected. Open an InPrivate tab and reload this page.' : '';
  $('storage_space_used').textContent =
    (new TextEncoder().encode(JSON.stringify(cookies)).length / 1024).toFixed(2);
  $('cookie_count').textContent = String(cookies.length);
  $('store_id').textContent = storeId || '-';
  $('status').textContent = last_status ? JSON.stringify(last_status, null, 2) : 'No operations recorded';
}
async function snapshot() {
  const storeId = await privateStoreId();
  if (!storeId) throw Error('No InPrivate cookie store');
  const cookies = await chrome.cookies.getAll({storeId});
  const {cookies:prev=[]} = await chrome.storage.local.get({cookies:[]});
  if (!cookies.length && prev.length) throw Error('Refusing to overwrite saved cookies with zero cookies');
  await chrome.storage.local.set({
    cookies, last_status: {operation:'manual save', count:cookies.length, storeId, time:Date.now()}
  });
}
async function restore(cookies) {
  const storeId = await privateStoreId();
  if (!storeId) throw Error('Open an InPrivate window first');
  let restored=0, failed=0;
  const errors=[];
  for (const c of cookies) {
    try {
      const result=await chrome.cookies.set(setDetails(c,storeId));
      if (result) restored++;
      else {failed++; errors.push(c.domain + ': no result');}
    } catch(e) {
      failed++;
      if(errors.length<8) errors.push(c.domain + ': ' + String(e));
    }
  }
  await chrome.storage.local.set({last_status: {
    operation:'manual restore', restored, failed, total:cookies.length,
    errors, time:Date.now()
  }});
}
async function perform(action) {
  try { await action(); }
  catch(e) { await chrome.storage.local.set({last_status: {error:String(e),time:Date.now()}}); }
  await refresh();
}
$('save').addEventListener('click',()=>perform(snapshot));
$('auto_save').addEventListener('change', e=>perform(async()=>{
  await chrome.storage.local.set({auto_save:e.target.checked});
  if (e.target.checked) await snapshot();
}));
$('delete').addEventListener('click',()=>perform(async()=>{
  await chrome.storage.local.remove('cookies');
  await chrome.storage.local.set({last_status:{operation:'delete backup',time:Date.now()}});
}));
$('backup').addEventListener('click',()=>perform(async()=>{
  const {cookies=[]}=await chrome.storage.local.get({cookies:[]});
  objectUrl=URL.createObjectURL(new Blob([JSON.stringify(cookies)],{type:'application/json'}));
  downloadId=await chrome.downloads.download({url:objectUrl,filename:'private-cookies.json',saveAs:true});
}));
chrome.downloads.onChanged.addListener(d=>{
  if(d.id===downloadId && d.state && d.state.current!=='in_progress' && objectUrl) {
    URL.revokeObjectURL(objectUrl); objectUrl=null;
  }
});
$('restore').addEventListener('click',()=>$('file_input').click());
$('file_input').addEventListener('change',()=>perform(async()=>{
  const file=$('file_input').files[0];
  if(!file) return;
  const cookies=JSON.parse(await file.text());
  if(!Array.isArray(cookies)) throw Error('Expected a cookie array');
  await chrome.storage.local.set({cookies});
  await restore(cookies);
  $('file_input').value='';
}));
$('refresh').addEventListener('click',refresh);
chrome.storage.onChanged.addListener(()=>refresh());
chrome.windows.onCreated.addListener(()=>refresh());
chrome.windows.onRemoved.addListener(()=>refresh());
document.addEventListener('DOMContentLoaded',refresh);
