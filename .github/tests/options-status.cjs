'use strict';
const vm=require('node:vm');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const elements=new Map();
const documentListeners={};
function el(id){
  if(!elements.has(id))elements.set(id,{
    id,textContent:'',disabled:false,checked:false,value:'',files:[],
    listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},
    click(){return this.listeners.click?.();}
  });
  return elements.get(id);
}
const document={getElementById:el,addEventListener(name,fn){documentListeners[name]=fn;}};
const stored={cookies:[{domain:'.example.test',name:'test',value:'v1',
  secure:true,path:'/',hostOnly:false,httpOnly:true,session:true,sameSite:'lax'}],
  auto_save:false,last_status:{operation:'previous successful restore',written:1}};
function onlyRequested(keys){
 if(typeof keys==='string')return Object.hasOwn(stored,keys)?{[keys]:stored[keys]}:{};
 if(Array.isArray(keys))return Object.fromEntries(keys.filter(k=>Object.hasOwn(stored,k)).map(k=>[k,stored[k]]));
 return Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,Object.hasOwn(stored,k)?stored[k]:v]));
}
const chrome={
 extension:{isAllowedIncognitoAccess:async()=>true},
 permissions:{contains:async()=>true},
 windows:{getAll:async()=>[{incognito:true,tabs:[{id:42}]}]},
 cookies:{getAllCookieStores:async()=>[{id:'1',tabIds:[42]}],
  getAll:async()=>stored.cookies,set:async(details)=>({...details,domain:'.example.test'})},
 storage:{local:{get:async(keys)=>onlyRequested(keys),
   set:async(data)=>{Object.assign(stored,data);},
   remove:async(key)=>{delete stored[key];}},
   session:{set:async()=>{}},
   onChanged:{addListener:()=>{}}},
 scripting:{executeScript:async({world})=>[{result:{
   readyState:'complete',visibilityState:'visible',
   localStorage:{accessible:true,entryCount:12},sessionStorage:{accessible:true,entryCount:2},
   indexedDB:{accessible:true,databaseCount:4},
   storageEstimate:{accessible:true,usageBytes:1234,quotaBytes:500000}
 }}]},
 tabs:{query:async()=>[{id:42,incognito:true,active:true,url:'https://discord.com/channels/@me'}]},
 downloads:{onChanged:{addListener:()=>{}},download:async()=>1}
};
vm.runInNewContext(fs.readFileSync('options.js','utf8'),
  {chrome,document,TextEncoder,console,URL,Blob,Date}, {filename:'options.js'});
(async()=>{
  await documentListeners.DOMContentLoaded();
  assert.match(el('status').textContent,/previous successful restore/,
    'Prior operation must appear after Options opens');
  await el('verify').click();
  assert.equal(stored.last_status.operation,'verify snapshot');
  assert.match(el('status').textContent,/verify snapshot/);
  await el('restore_saved').click();
  assert.equal(stored.last_status.operation,'manual restore');
  assert.match(el('status').textContent,/manual restore/);
  await el('storage_probe').click();
  assert.equal(stored.last_status.operation,'read-only Discord storage probe');
  assert.equal(stored.discord_probe_last.mainWorld.localStorage.entryCount,12);
  assert.match(el('storage_probe_output').textContent,/databaseCount/);
  assert.doesNotMatch(el('storage_probe_output').textContent,/SECRET_TOKEN_DO_NOT_LOG/);
  console.log('PASS: Options displays previous, Verify, Restore, and privacy-preserving Discord metadata');
})().catch(e=>{console.error(e);process.exitCode=1;});
