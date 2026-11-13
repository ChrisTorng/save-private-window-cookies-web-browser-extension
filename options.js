const $=id=>document.getElementById(id);

async function runDiscordStorageProbe(){
  if(!await chrome.extension.isAllowedIncognitoAccess())
    throw Error('Enable Allow in InPrivate in extension Details');
  const tabs=await chrome.tabs.query({incognito:true});
  const discordTabs=tabs.filter(t=>/^https:\/\/(www\.)?discord\.com\//.test(t.url||''));
  if(!discordTabs.length)
    throw Error('Open a Discord page (https://discord.com/) inside InPrivate first');
  const selected=discordTabs.find(t=>t.active)||discordTabs[0];
  // Only metadata comes back; never read keys, values, credentials, or network headers.
  async function metadataOnly(){
    const inspect=name=>{
      try{
        const v=globalThis[name];
        if(v==null)return {type:typeof v,accessible:false};
        return {type:typeof v,accessible:true,entryCount:Number(v.length)};
      }catch(e){return {accessible:false,errorName:e.name};}
    };
    let databases={accessible:false};
    try{
      if(globalThis.indexedDB){
        const ds=await globalThis.indexedDB.databases();
        databases={accessible:true,databaseCount:ds.length};
      }
    }catch(e){databases={accessible:false,errorName:e.name};}
    let usage={accessible:false};
    try{
      if(globalThis.navigator?.storage?.estimate){
        const x=await globalThis.navigator.storage.estimate();
        usage={accessible:true,usageBytes:x.usage??null,quotaBytes:x.quota??null};
      }
    }catch(e){usage={accessible:false,errorName:e.name};}
    return {
      readyState:document.readyState,visibilityState:document.visibilityState,
      localStorage:inspect('localStorage'),sessionStorage:inspect('sessionStorage'),
      indexedDB:databases,storageEstimate:usage
    };
  }
  async function inject(world){
    try{
      const result=await chrome.scripting.executeScript({
        target:{tabId:selected.id},world,func:metadataOnly
      });
      return result[0]?.result||{errorName:'No result'};
    }catch(e){return {errorName:e.name||'Error'};}
  }
  const entry={
    capturedAt:Date.now(),tabId:selected.id,
    pageHost:new URL(selected.url).hostname,
    mainWorld:await inject('MAIN'),isolatedWorld:await inject('ISOLATED')
  };
  await chrome.storage.local.set({discord_probe_last:entry});
}
function formatStorageProbe(last,baseline){
  if(!last&&!baseline)return 'No storage probe recorded';
  const result={last,lastBaseline:baseline||null};
  if(last&&baseline){
    const count=(x,w,k)=>x?.[w]?.[k]?.entryCount??null;
    result.delta={
      mainLocalStorage:count(last,'mainWorld','localStorage')-count(baseline,'mainWorld','localStorage'),
      mainSessionStorage:count(last,'mainWorld','sessionStorage')-count(baseline,'mainWorld','sessionStorage'),
      oldAt:baseline.capturedAt,newAt:last.capturedAt
    };
  }
  return JSON.stringify(result,null,2);
}

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
  const {auto_save=false,cookies=[],last_status,discord_probe_last=null,discord_probe_baseline=null}=await chrome.storage.local.get({
    auto_save:false,cookies:[],last_status:null,discord_probe_last:null,discord_probe_baseline:null});
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
  $('storage_probe_output').textContent=formatStorageProbe(discord_probe_last,discord_probe_baseline);
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

$('storage_probe').addEventListener('click',()=>runWithStatus(async()=>{
  await runDiscordStorageProbe();
  await chrome.storage.local.set({last_status:{operation:'read-only Discord storage probe',time:Date.now()}});
}));
$('storage_baseline').addEventListener('click',()=>runWithStatus(async()=>{
  const {discord_probe_last=null}=await chrome.storage.local.get({discord_probe_last:null});
  if(!discord_probe_last)throw Error('Run Inspect first');
  await chrome.storage.local.set({discord_probe_baseline:discord_probe_last,
    last_status:{operation:'set Discord probe baseline',time:Date.now()}});
}));
$('storage_clear_baseline').addEventListener('click',()=>runWithStatus(async()=>{
  await chrome.storage.local.remove('discord_probe_baseline');
  await chrome.storage.local.set({last_status:{operation:'clear Discord probe baseline',time:Date.now()}});
}));

$('refresh').addEventListener('click',refresh);
chrome.storage.onChanged.addListener(()=>void refresh());
document.addEventListener('DOMContentLoaded',refresh);
