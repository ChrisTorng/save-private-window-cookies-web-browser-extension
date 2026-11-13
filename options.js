const $=id=>document.getElementById(id);
let downloadId=null, objectUrl=null;
async function privateStore(){
  const wins=(await chrome.windows.getAll({populate:true})).filter(w=>w.incognito);
  const tabIds=new Set(wins.flatMap(w=>(w.tabs||[]).map(t=>t.id)));
  if(!tabIds.size) return null;
  const stores=await chrome.cookies.getAllCookieStores();
  return stores.find(s=>s.tabIds.some(id=>tabIds.has(id)))?.id??null;
}
function urlFor(c){
  const host=c.domain.startsWith('.')?c.domain.slice(1):c.domain;
  return (c.secure?'https://':'http://')+host+(c.path||'/');
}
function toSet(c,storeId){
  const d={url:urlFor(c),storeId,name:c.name,value:c.value,path:c.path||'/',
    secure:c.secure,httpOnly:c.httpOnly,sameSite:c.sameSite};
  if(!c.hostOnly)d.domain=c.domain;
  if(!c.session&&typeof c.expirationDate==='number')d.expirationDate=c.expirationDate;
  if(c.partitionKey)d.partitionKey=c.partitionKey;
  return d;
}
const key=c=>JSON.stringify([c.domain,c.path,c.name,c.partitionKey||null]);
async function runWithStatus(fn){
  try{await fn();}
  catch(e){await chrome.storage.local.set({last_status:{
    operation:'error',error:String(e),time:Date.now()}});}
  await refresh();
}
async function saveLive(){
  const storeId=await privateStore();
  if(!storeId)throw Error('Open an InPrivate tab first');
  const cookies=await chrome.cookies.getAll({storeId});
  const {cookies:old=[]}=await chrome.storage.local.get({cookies:[]});
  if(!cookies.length&&old.length)throw Error('Refusing to replace existing snapshot with zero cookies');
  await chrome.storage.local.set({cookies,last_status:{
    operation:'manual save',count:cookies.length,storeId,time:Date.now()}});
  return cookies;
}
async function verify(cookies){
  const storeId=await privateStore();
  if(!storeId)throw Error('Open an InPrivate tab first');
  const live=await chrome.cookies.getAll({storeId});
  const map=new Map(live.map(c=>[key(c),c]));
  let matched=0,missing=0,expired=0;
  const failures=[];
  for(const c of cookies){
    if(c.expirationDate&&c.expirationDate<=Date.now()/1000){expired++;continue;}
    const actual=map.get(key(c));
    if(actual&&actual.value===c.value)matched++;
    else{missing++;if(failures.length<10)failures.push(c.domain+' / '+c.name);}
  }
  const status={operation:'verify snapshot',stored:cookies.length,
    matched,missingOrChanged:missing,expired,failures,storeId,time:Date.now()};
  await chrome.storage.local.set({last_status:status});
  return status;
}
async function restore(cookies){
  const storeId=await privateStore();
  if(!storeId)throw Error('Open an InPrivate tab first');
  await chrome.storage.session.set({privateRestoring:true,privateInit:true});
  let written=0,failed=0,expired=0;
  const errors=[];
  try{
    for(const c of cookies){
      if(c.expirationDate&&c.expirationDate<=Date.now()/1000){expired++;continue;}
      try{
        const result=await chrome.cookies.set(toSet(c,storeId));
        if(result)written++;
        else{failed++;if(errors.length<10)errors.push(c.domain+' / '+c.name+': empty result');}
      }catch(e){
        failed++;
        if(errors.length<10)errors.push(c.domain+' / '+c.name+': '+String(e));
      }
    }
    const verification=await verify(cookies);
    await chrome.storage.local.set({last_status:{
      operation:'manual restore',storeId,total:cookies.length,written,failed,expired,
      readbackMatched:verification.matched,readbackMissing:verification.missingOrChanged,
      errors:errors.concat(verification.failures).slice(0,10),time:Date.now()}});
  }finally{
    await chrome.storage.session.set({privateRestoring:false});
  }
}
async function refresh(){
  const allowed=await chrome.extension.isAllowedIncognitoAccess();
  const access=await chrome.permissions.contains({origins:['<all_urls>']});
  const storeId=allowed?await privateStore():null;
  const {auto_save=false,cookies=[],last_status}=await chrome.storage.local.get({
    auto_save:false,cookies:[]});
  $('auto_save').checked=auto_save;
  $('auto_save').disabled=!(allowed&&access);
  $('save').disabled=!(allowed&&access&&storeId);
  $('verify').disabled=!(allowed&&access&&storeId&&cookies.length);
  $('restore_saved').disabled=!(allowed&&access&&storeId&&cookies.length);
  $('backup').disabled=!cookies.length;
  $('delete').disabled=!cookies.length;
  $('warning').textContent=!allowed?'Enable Allow in InPrivate in extension Details':
    !access?'Allow site access on all websites':
    !storeId?'Open an InPrivate tab; no InPrivate cookie store detected':'';
  $('cookie_count').textContent=String(cookies.length);
  $('storage_space_used').textContent=(new TextEncoder().encode(JSON.stringify(cookies)).length/1024).toFixed(2);
  $('store_id').textContent=storeId||'-';
  $('status').textContent=last_status?JSON.stringify(last_status,null,2):'No operations recorded';
}
$('save').addEventListener('click',()=>runWithStatus(saveLive));
$('auto_save').addEventListener('change',e=>runWithStatus(async()=>{
  await chrome.storage.local.set({auto_save:e.target.checked});
  if(e.target.checked)await saveLive();
}));
$('verify').addEventListener('click',()=>runWithStatus(async()=>{
  const {cookies=[]}=await chrome.storage.local.get({cookies:[]});await verify(cookies);
}));
$('restore_saved').addEventListener('click',()=>runWithStatus(async()=>{
  const {cookies=[]}=await chrome.storage.local.get({cookies:[]});await restore(cookies);
}));
$('delete').addEventListener('click',()=>runWithStatus(async()=>{
  await chrome.storage.local.remove('cookies');
  await chrome.storage.local.set({last_status:{operation:'delete stored backup',time:Date.now()}});
}));
$('backup').addEventListener('click',()=>runWithStatus(async()=>{
  // Export the snapshot. Save Live first when an InPrivate store is accessible.
  if(await privateStore())await saveLive();
  const {cookies=[]}=await chrome.storage.local.get({cookies:[]});
  objectUrl=URL.createObjectURL(new Blob([JSON.stringify(cookies)],{type:'application/json'}));
  downloadId=await chrome.downloads.download({
    url:objectUrl,filename:'inprivate-cookies.json',saveAs:true});
}));
chrome.downloads.onChanged.addListener(d=>{
  if(d.id===downloadId&&d.state&&d.state.current!=='in_progress'&&objectUrl){
    URL.revokeObjectURL(objectUrl);objectUrl=null;
  }
});
$('restore').addEventListener('click',()=>$('file_input').click());
$('file_input').addEventListener('change',()=>runWithStatus(async()=>{
  const file=$('file_input').files[0];
  if(!file)return;
  const cookies=JSON.parse(await file.text());
  if(!Array.isArray(cookies))throw Error('Expected JSON array');
  if(cookies.some(c=>typeof c.name!=='string'||typeof c.domain!=='string'||typeof c.value!=='string'))
    throw Error('Invalid cookie record');
  await chrome.storage.local.set({cookies});
  await restore(cookies);
  $('file_input').value='';
}));
$('refresh').addEventListener('click',refresh);
chrome.storage.onChanged.addListener(()=>void refresh());
document.addEventListener('DOMContentLoaded',refresh);
