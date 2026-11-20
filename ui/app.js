/* app.js — warren-polaris-api 请求客户端：多 tab、集合/分组、环境变量、cURL 导入导出、响应渲染编排。
 * 自原版 relay-devkit tools/api.js 移植，适配 DBX 沙箱：
 *   - 去 cap.http / /__proxy 代理（DBX 无宿主直发通道、无本地中继后端）；
 *   - 网络纯 fetch 直连，受 manifest 声明的 host.network 白名单 + 浏览器 CORS 约束；
 *   - 持久化走 DBXBridge.storage（声明 host.storage），降级内存；
 *   - 去 router/currentView 依赖（DBX 单视图）。
 * IIFE 启动；依赖：window.POLARIS_CORE（$ $$ uid esc el METHODS bytes ms methodColor setStatus toast copy fmtDate BINARY tryJSON）
 *           window.POLARIS_JV（getByPath collectPaths viewRaw viewObject viewTable toggleRawWrap filterBar configureViewHost）
 *           window.DBXBridge（storage ready）
 */
(function () {
const { $, $$, uid, esc, el, METHODS, bytes, ms, methodColor, setStatus, toast, copy, fmtDate, BINARY, tryJSON } = window.POLARIS_CORE;
const JV = window.POLARIS_JV;
const { getByPath, collectPaths, viewRaw, viewObject, viewTable, toggleRawWrap, filterBar } = JV;
const { parseCurl, toCurl, shortUrl, splitUrl } = window.POLARIS_CURL;
const DBX = window.DBXBridge;

/* ===================== 状态 + 持久化 ===================== */
const ST_KEY='warren-polaris-api.state.v2';   // 单键存全部状态（storage 256KiB/值上限足够）
let state={ tabs:[], activeTab:null, collections:[], envs:[], activeEnv:null };
let dragRid=null;   // 侧边栏正在拖拽的已保存请求 id
let ui={ sideCollapsed:false, layout:'v', reqH:240, reqW:520, timeoutMs:120000 };

/* 响应字节数估算（sidecar 已返回 size，此为降级估算） */
function respSize(ct, body, isBase64){
  if(!body) return 0;
  if(isBase64){ const pad=(body.match(/=+$/)||[''])[0].length; return Math.floor(body.length*3/4)-pad; }
  return new TextEncoder().encode(body).length;
}
/* sidecar 返回 base64 二进制 → Blob（供 blobUrl 预览/下载） */
function b64ToBlob(b64, ct){
  try{
    const bin=atob(b64); const u8=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
    return new Blob([u8],{type:ct||'application/octet-stream'});
  }catch(e){ return null; }
}

/* 浏览器 fetch 禁发头（forbidden header names + Sec- 前缀）。
 * DBX 沙箱纯 fetch 直连：这些头会被浏览器静默剥离（UI 无感知丢失）。
 * DBX 无 cap.http 宿主直发通道，无法绕过——只能提示用户这些头会丢失。 */
const BROWSER_STRIP=/^(cookie|cookie2|user-agent|referer|origin|host|date|dnt|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*|accept-encoding|content-length)$/i;
const blankRow = ()=>({id:uid(),on:true,k:'',v:''});
function newTab(seed){
  return Object.assign({
    id:uid(), name:'未命名请求', savedId:null, dirty:false,
    method:'GET', url:'', params:[blankRow()], headers:[blankRow()],
    bodyType:'none', body:'', formBody:[blankRow()],
    reqTab:'params', respView:'object', respPath:'', respFilter:'', tableSel:null,
    prettyCells:true, colW:{}, treeOpen:'auto', hiddenCols:{}, sort:{}, colOrder:{},
    response:null
  }, seed||{});
}
const activeTab = ()=> state.tabs.find(t=>t.id===state.activeTab);

/* persist 改为异步单键存储（DBXBridge.storage，声明 host.storage 后走 dbxPlugin.storage，
 * 否则内存降级）。剔除 response 等运行态。失败不阻塞 UI。 */
let _persistTimer=null;
function persist(){
  clearTimeout(_persistTimer);
  _persistTimer=setTimeout(()=>{
    const tabs=state.tabs.map(t=>{const c={...t};delete c.response;delete c.abortCtl;delete c.sendSeq;delete c.stopped;return c;});
    const snap={tabs,activeTab:state.activeTab,envs:state.envs,activeEnv:state.activeEnv,ui};
    /* 文件真源启用后，集合不再进 storage —— 磁盘上的 .http 是唯一副本。
     * 双写会立刻出现「storage 与文件谁算数」的二义，所以这里直接不写。 */
    if(!DOCS.enabled) snap.collections=state.collections;
    DBX.storage.set(ST_KEY, snap).catch(()=>{});
  },180);
}
async function load(){
  const snap = await DBX.storage.get(ST_KEY).catch(()=>null);
  if(snap && typeof snap==='object'){
    if(snap.tabs&&snap.tabs.length){ state.tabs=snap.tabs.map(x=>newTab(x)); state.activeTab=snap.activeTab; }
    if(Array.isArray(snap.collections)) state.collections=snap.collections;
    if(snap.envs){ state.envs=snap.envs||[]; state.activeEnv=snap.activeEnv||null; }
    if(snap.ui) ui=Object.assign(ui,snap.ui);
  }
  // 超时容错：历史存储可能无 timeoutMs 或类型异常，统一回落默认 120s
  if(typeof ui.timeoutMs!=='number' || !Number.isFinite(ui.timeoutMs) || ui.timeoutMs<0) ui.timeoutMs=120000;
  if(!state.collections.length || !state.envs.length) seed();
  if(!state.tabs.length){ const t=newTab(); state.tabs=[t]; state.activeTab=t.id; }
  if(!activeTab()) state.activeTab=state.tabs[0].id;
}
function sreq(name,method,url,extra){ return Object.assign({id:uid(),name,method,url,params:[blankRow()],headers:[blankRow()],bodyType:'none',body:'',formBody:[blankRow()]},extra||{}); }
function seed(){
  if(!state.envs.length){
    const demo={id:uid(),name:'Demo · jsonplaceholder',baseUrl:'https://jsonplaceholder.typicode.com',vars:[{id:uid(),on:true,k:'token',v:'demo-token-123'}]};
    state.envs=[demo]; state.activeEnv=demo.id;
  }
  if(!state.collections.length){
    const g={ id:uid(), name:'示例 · DEMO', collapsed:false, requests:[
      sreq('用户列表 {{baseUrl}}','GET','{{baseUrl}}/users'),
      sreq('单个 Todo(对象)','GET','{{baseUrl}}/todos/1'),
      sreq('用户 {{baseUrl}}/users/1','GET','{{baseUrl}}/users/1'),
      sreq('相册(嵌套数据→表格)','GET','{{baseUrl}}/albums'),
      sreq('新建 Post','POST','{{baseUrl}}/posts',{bodyType:'json',body:JSON.stringify({title:'polaris',body:'hello',userId:1},null,2),
        headers:[{id:uid(),on:true,k:'Authorization',v:'Bearer {{token}}'},blankRow()]}),
    ]};
    state.collections=[g];
  }
}

/* ===================== 资源目录：文件真源（v0.9.0） =====================
 * 一个 .http 文件 = 一个 collection。侧栏、保存、删除全部以磁盘为准；
 * storage 只留 tab / 环境 / 偏好。旧 storage 集合在首次启动时一次性搬成文件。
 * 数据形状不开新路：HttpStore.toLegacyCollections() 把解析结果投影成旧形状，
 * 下面的渲染与编辑代码一行不用改。
 */
const DOCS_KEY='warren-polaris-api.httpws.v1';   // 与 http-workspace.js 共用（资源目录 / 结果目录）
const DOCS={ enabled:false, dir:'', store:null, files:[], busy:false, lastScan:0,
             map:null, mapError:null, mapLoaded:false };
const STORE=window.POLARIS_STORE;

async function docsResolveDir(){
  try{ const s=await DBX.storage.get(DOCS_KEY); if(s&&s.workDir) return String(s.workDir); }catch(e){}
  try{ const d=await DBX.invoke('http/defaultDirs',{}); return String((d&&(d.workDir||d.homeDir))||''); }catch(e){}
  return '';
}

async function initDocs(){
  if(!STORE || !DBX || !DBX.invoke) return;
  const dir=await docsResolveDir();
  if(!dir) return;
  DOCS.dir=dir;
  DOCS.store=STORE.createStore(STORE.invokeHost(DBX.invoke),{dir});
  DOCS.enabled=true;
  /* 一次性迁移：storage 里的旧集合 → 每个 collection 一个 .http。
   * 幂等（目标已存在就留档到 .warren-migrate/，不覆盖），靠 ui.migratedAt 只跑一次。 */
  if(!ui.migratedAt && state.collections.length){
    try{
      const out=await STORE.migrateFromStorage(DOCS.store,state.collections,{});
      ui.migratedAt=Date.now(); persist();
      if(out.created.length) setStatus('已把 '+out.created.length+' 个旧分组写成 .http 文件 · '+dir,'ok');
      if(out.skipped.length) toast('有 '+out.skipped.length+' 个同名文件已存在，旧数据留档在 .warren-migrate/');
    }catch(e){ setStatus('迁移旧分组失败：'+(e.message||e),'warn'); }
  }
  await loadEnvsFromFile();
  await loadWorkspaceMap();
  await refreshDocs(true);
}

/* 侧栏映射（wpa-workspace.json，S2.5a）。它只决定「哪些文件、挂哪个文件夹、什么顺序」，
 * 内容真源仍是 .http 文件本身。
 * **只有第一次**（映射不存在，或刚被重建）才把目录里已有的 .http 全量登记；
 * 之后新增的文件要走底部「发现 N 个未登记」由用户点，否则「映射为权威」就退化成扫目录。
 * 已有 folders 的名字/顺序/折叠态一律不动（测试见 tools/map.test.mjs）。
 * 手改坏的映射先留一份 .broken.json 再重建，绝不让一个坏 JSON 卡死侧栏。 */
async function loadWorkspaceMap(){
  const M=window.POLARIS_MAP;
  if(!DOCS.enabled||!M||!DOCS.store) return null;
  try{
    const r=await M.load(DOCS.store.host,DOCS.dir);
    const firstRun=!r.exists||!!r.error;
    DOCS.mapError=r.error||null;
    if(r.error){
      const bak=r.path.replace(/\.json$/i,'.broken.json');
      try{ await DOCS.store.host.rename(r.path,bak,{overwrite:true}); }catch(e){}
      toast('侧栏映射解析失败，已留档 '+STORE.baseName(bak)+' 并重建');
    }
    DOCS.map=r.map;
    if(firstRun){
      const reg=await M.ensureRegistered(DOCS.store.host,DOCS.dir,DOCS.map);
      DOCS.map=reg.map;
      if(reg.added.length||!r.exists){
        const w=await M.save(DOCS.store.host,DOCS.dir,DOCS.map);
        if(!w.ok) setStatus('写侧栏映射失败：'+(w.reason||'未知'),'warn');
        else if(reg.added.length) setStatus('已登记 '+reg.added.length+' 个 .http 到侧栏映射','ok');
      }
    }
    DOCS.mapLoaded=true;
    /* 启动期已经建好的文件（比如 http-editor 种的 examples.http）在这里补登记 */
    if(DOCS.pendingRegister&&DOCS.pendingRegister.length){
      const queued=DOCS.pendingRegister.slice();
      DOCS.pendingRegister=[];
      for(const p of queued) await registerDocFile(p);
    }
    return DOCS.map;
  }catch(e){
    DOCS.mapError=String((e&&e.message)||e);
    DOCS.mapLoaded=false;
    return null;
  }
}

/* 新建文件后立刻登记，否则「映射为权威」的侧栏会把它当成不存在（S2.5b 起生效）。
 * 映射还没读出来时先排队，等 loadWorkspaceMap 完成后补登记（启动期 http-editor 种示例就是这种时序）。 */
async function registerDocFile(path){
  const M=window.POLARIS_MAP;
  if(!M||!path) return;
  if(!DOCS.map){ DOCS.pendingRegister=DOCS.pendingRegister||[]; DOCS.pendingRegister.push(path); return; }
  try{
    const e=M.toEntry(DOCS.dir,path);
    if(M.entries(DOCS.map).some(x=>M.pathKey(x)===M.pathKey(e))) return;
    DOCS.map.unfiled.push(e);
    await M.save(DOCS.store.host,DOCS.dir,DOCS.map);
  }catch(err){ /* 登记失败不影响文件本身，下次启动会补 */ }
}

/* 扫目录 + 把「映射里登记、但住在资源目录外」的文件一并读进来。
 * 侧栏只按映射显示，可外部文件的 exists 没法靠扫目录判断，只能真读一次：
 * 读得到就是存在，读不到（被移走/删掉/没权限）就交给 resolve 标成「找不到」。 */
async function collectDocsList(){
  const list=await DOCS.store.list();
  const M=window.POLARIS_MAP;
  if(!M||!DOCS.map) return list;
  const seen={};
  list.forEach(x=>{ seen[M.pathKey(x.path)]=1; });
  for(const entry of M.entries(DOCS.map)){
    const abs=M.toAbs(DOCS.dir,entry);
    if(M.relOf(DOCS.dir,abs)!=null) continue;      // 目录内的已在 list 里
    if(seen[M.pathKey(abs)]) continue;
    seen[M.pathKey(abs)]=1;
    try{
      const rd=await DOCS.store.read(abs);
      list.push({
        name: STORE.baseName(abs).replace(/\.(http|rest)$/i,''),
        fileName: STORE.baseName(abs),
        path: abs,
        mtime: rd.mtime,
        size: (rd.text||'').length,
        requests: rd.parsed.requests,
        warnings: rd.parsed.warnings,
        fileId: rd.parsed.fileId,
        fileVars: rd.parsed.fileVars,
        error: null,
        outside: true
      });
    }catch(e){
      /* 读不到就不放进 list：resolve 拿不到这个路径，自然标成「找不到」 */
    }
  }
  list.sort((a,b)=>String(a.name).localeCompare(String(b.name),'zh-Hans-CN'));
  return list;
}

/* 扫目录 → 投影成 state.collections。busy 期间的重入直接忽略（保存后连刷两次很常见）。 */
async function refreshDocs(quiet){
  if(!DOCS.enabled) return false;
  if(DOCS.busy) return false;
  DOCS.busy=true;
  try{
    const list=await collectDocsList();
    DOCS.files=list; DOCS.lastScan=Date.now();
    applyDocs(list);
    rebindTabs();
    const sync=syncTabsWithDocs();
    renderSidebar();
    if(sync.reloaded){
      renderTabs();
      if(sync.reloadedIds.indexOf(state.activeTab)>=0){ renderReqEditor(); renderRequestBar(); }
      setStatus('磁盘内容已更新，已重新载入 '+sync.reloaded+' 个请求','ok');
    }
    if(sync.conflicts){ renderTabs(); renderConflictBar(); }
    const head=$('.side-head .t'); if(head) head.title=DOCS.dir;
    return true;
  }catch(e){
    if(!quiet) setStatus('读取资源目录失败：'+(e.message||e),'warn');
    return false;
  }finally{ DOCS.busy=false; }
}

function applyDocs(list){
  const groups=STORE.toLegacyCollections(list,{blankRow});
  const col=ui.collapsed||{};
  groups.forEach(g=>{ if(col[g.path]) g.collapsed=true; });
  state.collections=groups;
}

/* 只重读一个文件并就地替换对应的分组（保存/删除后不必整目录重扫，
 * 也不会因为重扫而把其它文件的折叠状态、行号快照抖掉）。 */
async function patchGroup(path){
  try{
    const rd=await DOCS.store.read(path);
    const name=STORE.baseName(path).replace(/\.(http|rest)$/i,'');
    const item={ name, fileName:STORE.baseName(path), path, mtime:rd.mtime, size:(rd.text||'').length,
                 requests:rd.parsed.requests, warnings:rd.parsed.warnings, fileId:rd.parsed.fileId, error:null };
    const g=STORE.toLegacyCollections([item],{blankRow})[0];
    const i=state.collections.findIndex(x=>x.path===path);
    if(i>=0){ g.collapsed=state.collections[i].collapsed; state.collections[i]=g; }
    else state.collections.push(g);
    return g;
  }catch(e){ return null; }
}

/* 文件被外部改过之后，把「从文件打开的 tab」重新挂到新的请求对象上。
 * 顺序：interfaceId → 文件+行号+方法 → 文件+名称+方法（唯一）。
 * 全对不上说明这一段真的没了，tab 退化成未保存（不静默绑到别的段）。 */
function findDocRequest(ref){
  const cands=[];
  state.collections.forEach(g=>{
    if(ref.file && g.path!==ref.file) return;
    g.requests.forEach(r=>cands.push({g,r}));
  });
  if(ref.interfaceId){ const h=cands.find(c=>c.r.interfaceId===ref.interfaceId); if(h) return h; }
  if(ref.line!=null){ const h=cands.find(c=>c.r.httpSource && c.r.httpSource.line===ref.line && (!ref.method||c.r.method===ref.method)); if(h) return h; }
  if(ref.name){ const same=cands.filter(c=>c.r.name===ref.name && (!ref.method||c.r.method===ref.method)); if(same.length===1) return same[0]; }
  return null;
}
function rebindTabs(){
  state.tabs.forEach(t=>{
    if(!t.docRef) return;
    const hit=findDocRequest(t.docRef);
    if(hit){
      t.savedId=hit.r.id;
      t.docRef={ file:hit.g.path, line:hit.r.httpSource?hit.r.httpSource.line:null,
                 interfaceId:hit.r.interfaceId||null, name:hit.r.name, method:hit.r.method };
      syncTabVars(t);
    }else{ t.savedId=null; t.docRef=null; t.fileVars={}; }
  });
}
/* baseMtime = 这个 tab 的内容「读到的是哪一版」。写回时拿它当基线，磁盘变了就 CONFLICT，
 * 不能拿刚扫出来的 g.mtime —— 那样外部改动会被静默覆盖。 */
function setTabDocRef(t,path,req,mtime){
  t.savedId=req.id;
  t.docRef={ file:path, line:req.httpSource?req.httpSource.line:null,
             interfaceId:req.interfaceId||null, name:req.name, method:req.method };
  if(mtime!=null) t.baseMtime=Math.round(mtime);
  else if(req.httpSource&&req.httpSource.mtime) t.baseMtime=Math.round(req.httpSource.mtime);
  t.docConflict=null;
  syncTabVars(t);
}

/* 把磁盘上的那一段灌回 tab（清掉草稿状态）。字段一一对应，别漏 bodyType/formBody：
 * 漏一个就会出现「表单看着是新的、发出去还是旧的」。 */
function applyRequestToTab(t,r){
  if(!r) return false;
  t.name=r.name; t.method=r.method; t.url=r.url||'';
  t.headers=JSON.parse(JSON.stringify(r.headers&&r.headers.length?r.headers:[blankRow()]));
  t.params=[blankRow()];
  t.formBody=JSON.parse(JSON.stringify(r.formBody&&r.formBody.length?r.formBody:[blankRow()]));
  t.bodyType=r.bodyType||'none'; t.body=r.body||'';
  t.dirty=false;
  return true;
}

/* 扫完目录后对齐 tab：干净的直接换成磁盘内容（外部改了 URL，切回来就能看到）；
 * 有草稿的不动内容，只挂冲突标记，让用户自己选哪一份。 */
function syncTabsWithDocs(){
  let reloaded=0, conflicts=0; const reloadedIds=[];
  state.tabs.forEach(t=>{
    if(!t.docRef||!t.docRef.file) return;
    const g=state.collections.find(x=>x.path===t.docRef.file);
    if(!g){
      if(!t.docConflict){ t.docConflict={ file:t.docRef.file, missing:true, name:STORE.baseName(t.docRef.file) }; conflicts++; }
      return;
    }
    const r=g.requests.find(x=>x.id===t.savedId)||
            (t.docRef.interfaceId?g.requests.find(x=>x.interfaceId===t.docRef.interfaceId):null)||
            null;
    if(!r) return;
    if(t.baseMtime==null){ t.baseMtime=Math.round(g.mtime||0); return; }   // 0.6.x 遗留下来的 tab：先认当前版本
    if(Math.round(g.mtime||0)===Math.round(t.baseMtime)) return;
    if(t.dirty){
      if(!t.docConflict){ t.docConflict={ file:g.path, mtime:Math.round(g.mtime||0), name:g.name }; conflicts++; }
    }else{
      applyRequestToTab(t,r);
      setTabDocRef(t,g.path,r,g.mtime);
      reloaded++; reloadedIds.push(t.id);
    }
  });
  return { reloaded, reloadedIds, conflicts };
}

/* 冲突栏：只在「当前 tab 有冲突」时出现，两个按钮直接决定谁赢，不做隐式覆盖 */
function renderConflictBar(){
  const bar=$('#docConflict'); if(!bar) return;
  const t=activeTab();
  const c=t&&t.docConflict;
  if(!c||c.dismissed){ bar.style.display='none'; bar.innerHTML=''; return; }
  bar.style.display='flex';
  bar.innerHTML=
    '<span class="dc-ico">⚠</span>'+
    '<span class="dc-msg">'+(c.missing
      ? ('文件 <b>'+esc(c.name||'')+'</b> 已不在磁盘上，当前内容还在这个 tab 里')
      : ('磁盘上的 <b>'+esc(c.name||'')+'</b> 已被外部修改（IDE 保存 / git 切换），你这边也有未保存的改动'))+
    '</span>'+
    '<span class="dc-acts">'+
      (c.missing?'':'<button class="dc-btn primary" data-act="reload">加载磁盘版本</button>')+
      '<button class="dc-btn" data-act="mine">保留我的'+(c.missing?'':'并覆盖')+'</button>'+
      '<button class="dc-btn ghost" data-act="later" title="先不改，点 tab 上的 ⚠ 可再打开这条">稍后</button>'+
    '</span>';
  const btn=act=>bar.querySelector('[data-act="'+act+'"]');
  const on=btn('reload'); if(on) on.onclick=()=>resolveConflict(t,'reload');
  const om=btn('mine');   if(om) om.onclick=()=>resolveConflict(t,'mine');
  const ol=btn('later');  if(ol) ol.onclick=()=>{ c.dismissed=true; renderConflictBar(); };
}

async function resolveConflict(t,how){
  if(!t) return;
  if(how==='reload'){
    const g=state.collections.find(x=>x.path===(t.docRef&&t.docRef.file));
    const r=g&&(g.requests.find(x=>x.id===t.savedId)||
                (t.docRef.interfaceId?g.requests.find(x=>x.interfaceId===t.docRef.interfaceId):null));
    if(!g||!r){ setStatus('磁盘上已经找不到这一段了，保留当前内容','warn'); t.docConflict=null; renderAll(); return; }
    applyRequestToTab(t,r);
    setTabDocRef(t,g.path,r,g.mtime);
    renderAll(); persist();
    setStatus('已载入磁盘版本','ok');
    return;
  }
  /* 保留我的：先把基线抬到磁盘当前版本（否则写回又会被判冲突），再立刻覆盖 */
  const g=state.collections.find(x=>x.path===(t.docRef&&t.docRef.file));
  const r=g&&(g.requests.find(x=>x.id===t.savedId)||
              (t.docRef.interfaceId?g.requests.find(x=>x.interfaceId===t.docRef.interfaceId):null));
  if(!g||!r){
    t.docConflict=null; t.savedId=null; t.docRef=null;
    renderAll(); persist();
    setStatus('文件已不在磁盘上，这段内容保留为未保存的 tab','warn');
    return;
  }
  t.baseMtime=Math.round(g.mtime||0); t.docConflict=null;
  renderConflictBar();
  await saveToDoc(t,{g,r});
}

/* tab → 文件里那一段要写的内容。URL 保持 {{var}} 原文（变量只在发送时展开）。 */
function storeReqFromTab(t){
  const headers=t.headers.filter(r=>r.on!==false&&r.k).map(r=>({k:r.k,v:r.v==null?'':r.v}));
  const hasCt=headers.some(h=>/^content-type$/i.test(h.k));
  let body='';
  if(!['GET','HEAD'].includes(t.method)){
    if(t.bodyType==='json'||t.bodyType==='text') body=t.body||'';
    else if(t.bodyType==='form') body=t.body||t.formBody.filter(r=>r.on!==false&&r.k).map(r=>r.k+'='+r.v).join('&');
  }
  if(!hasCt&&body){
    if(t.bodyType==='json') headers.push({k:'Content-Type',v:'application/json'});
    else if(t.bodyType==='form') headers.push({k:'Content-Type',v:'application/x-www-form-urlencoded'});
  }
  return { name:t.name, title:t.name, method:t.method, url:t.url, headers, body, bodyType:t.bodyType };
}

/* 把当前 tab 写回它所属的那一段 */
async function saveToDoc(t,f){
  if(!t.url){ setStatus('请先输入 URL','warn'); return false; }
  const req=storeReqFromTab(t);
  let res;
  try{
    res=await DOCS.store.writeRequest(f.r.httpSource.file,{
      line:f.r.httpSource.line, method:t.method, url:req.url,
      headers:req.headers, body:req.body, bodyType:req.bodyType,
      interfaceId:f.r.httpSource.interfaceId||(t.docRef&&t.docRef.interfaceId)||null
    },{ baseMtime:t.baseMtime!=null?t.baseMtime:f.g.mtime });
  }catch(e){
    setStatus('保存失败：'+(e.message||e),'err'); return false;
  }

  if(res.ok){
    t.dirty=false;
    const g=await patchGroup(f.r.httpSource.file);
    if(g&&g.requests[res.segment]){
      const nr=g.requests[res.segment];
      setTabDocRef(t,f.r.httpSource.file,nr,g.mtime);
      if(nr.name!==t.name){ t.name=nr.name; renderTabs(); }   // tab 标题跟随文件里的 ###，避免两边两套名字
    }
    renderTabs(); renderSidebar(); renderConflictBar();
    setStatus('已写入「'+f.g.name+'」','ok');
    toast('已更新「'+esc(t.name)+'」 <b>✓</b>');
    return true;
  }
  if(res.reason==='CONFLICT'){
    /* 不静默覆盖：先把磁盘版本拉回来（干净 tab 会自动同步，脏 tab 挂冲突标记），
     * 然后让用户在「加载磁盘版本 / 保留我的」之间明确选一次。 */
    await refreshDocs(true);
    if(!t.docConflict) t.docConflict={ file:f.r.httpSource.file, mtime:res.current||0, name:f.g.name };
    t.docConflict.dismissed=false;   /* 用户点过保存就重新亮出来，不能因为先前「稍后」而静默 */
    renderConflictBar();
    setStatus('文件已在别处被修改，请选择保留哪一份','warn');
    toast('「'+esc(t.name)+'」在磁盘上被改过 <b>⚠</b>');
    return false;
  }
  setStatus('保存失败：'+(res.reason||'写入被拒')+(res.error?(' · '+res.error):''),'err');
  return false;
}

/* 外部改动（IDEA 里保存、git 切分支）后切回插件时自动重扫；合帧避免抖动 */
let _docsTimer=null;
function scheduleDocsRefresh(delay){
  if(!DOCS.enabled) return;
  clearTimeout(_docsTimer);
  _docsTimer=setTimeout(()=>{ refreshDocs(true); }, delay||300);
}

/* ===================== 双向跳转（S2.3） =====================
 * api → 源码：把当前 tab 那一段在浮层里滚出来并选中（脏了先落盘，否则源码看到的还是旧 URL）。
 * 源码 → api：按 interfaceId / 行号 / 名称 在同一次快照里认出那一段，开成请求 tab。
 * 两侧都不猜：认不出就明说，绝不落到「看起来像」的别的段上。 */
function locateDocRequest(g,info){
  if(!g||!info) return null;
  const rs=g.requests||[];
  if(info.interfaceId){ const h=rs.find(x=>x.interfaceId===info.interfaceId); if(h) return h; }
  if(info.line!=null){
    const ln=Number(info.line);
    const h=rs.find(x=>x.httpSource&&x.httpSource.line===ln&&(!info.method||x.method===info.method));
    if(h) return h;
  }
  if(info.name){
    const same=rs.filter(x=>x.name===info.name&&(!info.method||x.method===info.method));
    if(same.length===1) return same[0];
  }
  return null;
}

async function openInFormForDoc(path,info){
  info=info||{};
  if(!path){ setStatus('这段还没绑定文件','warn'); return false; }
  let g=state.collections.find(x=>x.path===path);
  if(!g){ await refreshDocs(true); g=state.collections.find(x=>x.path===path); }
  let r=locateDocRequest(g,info);
  if(!r){                                    /* 快照旧了（刚在源码里改过）→ 只重读这一个文件再认一次 */
    const gg=await patchGroup(path);
    if(gg){ g=gg; r=locateDocRequest(g,info); }
  }
  if(!r){ setStatus('文件里找不到这一段（可能刚被改动），先点 ↻ 重扫再看','warn'); return false; }
  openSaved(r);
  setStatus('已切到表单：'+r.name,'ok');
  return true;
}

async function openSourceForTab(){
  const t=activeTab(); if(!t) return false;
  const ref=t.docRef;
  if(!ref||!ref.file){ setStatus('这个请求还没落到 .http 文件，先在表单里保存一次','warn'); return false; }
  if(!window.POLARIS_EDITOR||!window.POLARIS_EDITOR.openAt){ setStatus('.http 源码视图暂不可用','warn'); return false; }
  if(t.dirty){                               /* 先把表单里的改动写回那一段，再跳，否则源码里看不到刚改的 URL */
    const ok=await saveCurrent();
    if(ok===false) return false;
    const fresh=findSaved(t.savedId);
    if(fresh&&fresh.r.httpSource) ref.line=fresh.r.httpSource.line;
  }
  const done=await window.POLARIS_EDITOR.openAt(ref.file, ref.line);
  if(done) setStatus('已在源码中定位到第 '+(ref.line||'?')+' 行','ok');
  else setStatus('打开 .http 源码失败：文件可能已被移动','warn');
  return done;
}

/* ===================== 变量解析 ===================== */
function curEnv(){ return state.envs.find(e=>e.id===state.activeEnv); }
/* ===================== 变量求值（表单侧） =====================
 * 统一走 http-file.js 的那一套：文件级 @var → 环境变量 → 内置动态变量。
 * 以前这里只认环境，于是 .http 里写的 @base = ... 在表单里根本不生效，
 * 发出去的是字面 `{{base}}`（ENOTFOUND）—— 同一个文件两种视图给出两种结果。 */
function fileVarsOf(path){
  if(!path) return {};
  const g=state.collections.find(x=>x.path===path);
  return (g&&g.fileVars)||{};
}
/* 把「当前文件里的 @变量」挂到 tab 上：打开、重绑、保存后都要对齐 */
function syncTabVars(t){
  if(!t) return t;
  t.fileVars = t.docRef ? fileVarsOf(t.docRef.file) : {};
  return t;
}
function envAsVars(){
  const env=curEnv(); const out={};
  if(!env) return out;
  if(env.baseUrl) out.baseUrl=env.baseUrl;
  (env.vars||[]).forEach(r=>{ if(r.on && r.k) out[r.k]=r.v==null?'':r.v; });
  return out;
}
/* 跨请求引用 {{名字.response.body.$.x}} 的取值池：发送成功后按 tab 名记一份 */
const RESP_CACHE={};

/* ---------- 环境：http-client.env.json 是真源 ----------
 * state.envs 只是它的一份内存投影（UI 到处在用 env.id / env.vars 这种形状），
 * 切换环境、关掉环境面板时写回文件；启动时从文件读。
 * 两边都想当真源的话，用户改文件不生效、在 UI 改又不落盘，迟早对不上。 */
function envsFromFile(json){
  if(!json || typeof json!=='object') return null;
  const out=[];
  Object.keys(json).forEach(name=>{
    const v=json[name]||{};
    const vars=Object.keys(v).filter(k=>k!=='baseUrl')
      .map(k=>({ id:'ev:'+name+':'+k, on:true, k:k, v:v[k]==null?'':String(v[k]) }));
    out.push({ id:'env:'+name, name:name, baseUrl:v.baseUrl||'', vars:vars.length?vars:[blankRow()] });
  });
  return out.length?out:null;
}
function envsToFile(){
  const out={};
  state.envs.forEach(e=>{
    const name=String(e.name||'').trim(); if(!name) return;
    const o={};
    if(e.baseUrl) o.baseUrl=e.baseUrl;
    (e.vars||[]).forEach(r=>{ if(r.on && r.k) o[r.k]=r.v==null?'':String(r.v); });
    out[name]=o;
  });
  return out;
}
async function saveEnvsToFile(){
  if(!DOCS.enabled || !DOCS.dir || !STORE) return false;
  try{
    await DBX.invoke('http/writeFile',{
      path:STORE.joinPath(DOCS.dir,'http-client.env.json'),
      content:JSON.stringify(envsToFile(),null,2)+'\n'
    });
    return true;
  }catch(e){
    setStatus('环境写入 '+ 'http-client.env.json 失败：'+(e.message||e),'err');
    return false;
  }
}
async function loadEnvsFromFile(){
  if(!DOCS.enabled || !DOCS.dir) return false;
  let r=null;
  try{ r=await DBX.invoke('http/readEnvFiles',{dir:DOCS.dir}); }catch(e){ return false; }
  const parsed=envsFromFile(r&&r.public);
  if(parsed){
    const keepName=(curEnv()&&curEnv().name)||ui.envName||null;
    state.envs=parsed;
    const hit=parsed.find(e=>e.name===keepName);
    state.activeEnv=hit?hit.id:parsed[0].id;
    ui.envName=hit?hit.name:parsed[0].name;
    return true;
  }
  /* 文件里还没有环境：把 storage 里的旧环境写进去一次，不让用户白填 */
  if(state.envs.length && !ui.envsMigratedAt){
    ui.envsMigratedAt=Date.now();
    await saveEnvsToFile();
  }
  return false;
}
/* 记下「当前是哪个环境」，下次启动按名字找回来（env.id 是按名字算的，也稳） */
function rememberEnv(env){ ui.envName=env?env.name:null; }


function resolveVars(str,t){
  if(str==null || String(str).indexOf('{{')<0) return str;
  const tab=t||(typeof activeTab==='function'?activeTab():null);
  const vars=(tab&&tab.fileVars)||{};
  const H=window.POLARIS_HTTP;
  if(H&&(H.resolveDeep||H.resolveVars)){
    const fn=H.resolveDeep||H.resolveVars;
    return fn(String(str),{ vars:vars, envs:{__cur:envAsVars()}, activeEnv:'__cur', responses:RESP_CACHE });
  }
  /* 兜底：http-file.js 没加载时至少别把环境丢了 */
  const env=envAsVars();
  return String(str).replace(/\{\{\s*([\w.\-]+)\s*\}\}/g,(m,key)=>{
    if(Object.prototype.hasOwnProperty.call(vars,key)) return String(vars[key]);
    return Object.prototype.hasOwnProperty.call(env,key)? String(env[key]) : m;
  });
}

/* ===================== 方法下拉（延迟到 initApi 绑定） ===================== */
function bindMethodMenu(){
  const menu=$('#methodMenu'); if(!menu)return;
  METHODS.forEach(m=>{ const b=el('button',methodColor(m),m); b.onclick=()=>{ const t=activeTab(); t.method=m; markDirty(t); $('#methodMenu').classList.remove('open'); renderRequestBar(); renderReqEditor(); persist(); }; menu.appendChild(b); });
}
function bindTopEvents(){
  const ms=$('#methodSel'); if(ms) ms.onclick=e=>{ e.stopPropagation(); $('#methodMenu').classList.toggle('open'); };
  const es=$('#envSel'); if(es) es.onclick=e=>{ e.stopPropagation(); $('#envMenu').classList.toggle('open'); };
  document.addEventListener('click',()=>{ const mm=$('#methodMenu'); if(mm)mm.classList.remove('open'); const em=$('#envMenu'); if(em)em.classList.remove('open'); $$('.path-menu').forEach(m=>m.classList.remove('open')); });
}

/* ===================== 侧栏 ===================== */
/* 映射模式下的路径比对：统一分隔符、Windows 形态不分大小写（与 POLARIS_MAP.pathKey 一致） */
function sidebarKey(p){ return window.POLARIS_MAP?window.POLARIS_MAP.pathKey(p):String(p||'').replace(/\\/g,'/').toLowerCase(); }
function groupOfPath(path){ const k=sidebarKey(path); return state.collections.find(g=>g.path&&sidebarKey(g.path)===k)||null; }

function renderSidebar(){
  const tree=$('#tree');
  const prevScroll=tree.scrollTop;   // 重建会重置 scrollTop，先记录
  tree.innerHTML='';
  const q=($('#search').value||'').toLowerCase().trim();
  const stat={ total:0, shown:0 };
  if(DOCS.enabled && DOCS.map && window.POLARIS_MAP){
    renderSidebarMapped(tree,q,stat);
  }else{
    if(!state.collections.length) tree.appendChild(el('div','tree-empty','还没有任何分组。<br>点击右上角 ＋ 新建一个。'));
    state.collections.forEach(g=>{ const node=renderFileGroup(g,q,stat); if(node) tree.appendChild(node); });
    if(q && stat.shown===0) tree.appendChild(el('div','tree-empty','没有匹配「'+esc(q)+'」的请求。'));
  }
  if(prevScroll) tree.scrollTop=prevScroll;   // 恢复滚动位置（搜索/点击重建不打断浏览）
  $('#stSaved').textContent=stat.total;
}

/* 映射模式：文件夹 → 文件 → 请求。顺序与归属全来自 wpa-workspace.json（S2.5b）。 */
function renderSidebarMapped(tree,q,stat){
  const M=window.POLARIS_MAP;
  const view=M.resolve(DOCS.map,DOCS.dir,(DOCS.files||[]).map(f=>f.path));
  view.folders.forEach(f=>{ const sec=renderFolderNode(f,q,stat); if(sec) tree.appendChild(sec); });
  view.unfiled.forEach(node=>{ const n=renderMapFile(node,q,stat); if(n) tree.appendChild(n); });
  if(!view.folders.length && !view.unfiled.length){
    tree.appendChild(el('div','tree-empty','侧栏里还没有登记任何文件。<br>点右上角 ＋ 新建，或把 .http 放进资源目录后点 ↻。'));
  }else if(q && stat.shown===0){
    tree.appendChild(el('div','tree-empty','没有匹配「'+esc(q)+'」的请求。'));
  }
  const pend=mapPending();
  if(pend.length){
    const b=el('button','pending-bar','发现 '+pend.length+' 个未登记文件 · 点这里加入');
    b.title='磁盘上有、映射里没有的 .http。加入只写映射，不动文件内容。';
    b.onclick=openPendingFiles;
    tree.appendChild(b);
  }
  const nf=el('button','pending-bar ghost','＋ 新建文件夹');
  nf.onclick=newFolderFlow;
  tree.appendChild(nf);
}

function renderFolderNode(f,q,stat){
  const M=window.POLARIS_MAP;
  const body=el('div','folder-body');
  let any=false;
  f.files.forEach(node=>{ const n=renderMapFile(node,q,stat); if(n){ body.appendChild(n); any=true; } });
  if(q && !any) return null;            // 搜索时整夹没有命中就不占地方
  const sec=el('div','folder'+(f.collapsed&&!q?' collapsed':''));
  const head=el('div','folder-head');
  head.innerHTML=`<span class="caret">▼</span><span class="fname">${esc(f.name)}</span><span class="gcount">${f.files.length}</span>`;
  head.title='文件夹 · 顺序与归属来自 wpa-workspace.json';
  const act=el('span','gact');
  const ren=el('button','x','✎'); ren.title='重命名文件夹'; ren.onclick=e=>{e.stopPropagation();renameFolderFlow(f);};
  const del=el('button','x','🗑'); del.title='删除文件夹（文件退回根，不删文件）'; del.onclick=e=>{e.stopPropagation();removeFolderFlow(f);};
  act.append(ren,del); head.appendChild(act);
  head.onclick=()=>{
    const r=M.setFolderCollapsed(DOCS.map,f.name,!f.collapsed);
    if(r.ok){ DOCS.map=r.map; saveWorkspaceMap(); renderSidebar(); }
  };
  sec.append(head,body);
  return sec;
}

/* 映射里的一个文件节点 → 一行文件分组；找不到的给灰色占位，绝不当成没登记 */
function renderMapFile(node,q,stat){
  if(node.dup) return null;             // 同一文件登记两次：只认第一条
  const g=node.exists===false?null:groupOfPath(node.path);
  if(!g){
    if(q && node.name.toLowerCase().indexOf(q)<0) return null;
    return renderMissingFile(node);
  }
  const fileEl=renderFileGroup(g,q,stat);
  if(!fileEl) return null;
  if(node.outside){
    const tag=el('span','outside-tag','外部'); tag.title=node.path;
    const cnt=fileEl.querySelector('.gcount');
    if(cnt) cnt.insertAdjacentElement('beforebegin',tag);
  }
  return fileEl;
}

function renderMissingFile(node){
  const item=el('div','miss-item');
  item.innerHTML=`<span class="mb">?</span><span class="rn">${esc(node.name)}</span><span class="miss">找不到</span>`;
  item.title=node.entry+'\n文件已不在原位置。可以重新定位；移除登记不会动文件本身。';
  const loc=el('button','rx rr','↻'); loc.title='重新定位…'; loc.onclick=e=>{e.stopPropagation();relocateFlow(node);};
  const rm=el('button','rx','✕'); rm.title='从侧栏移除登记（不删文件）'; rm.onclick=e=>{e.stopPropagation();unregisterFlow(node);};
  item.append(loc,rm);
  return item;
}

/* 一个文件分组（含请求行）。返回 null 表示被搜索过滤掉了。 */
function renderFileGroup(g,q,stat){
    const matched=g.requests.filter(r=>!q||r.name.toLowerCase().includes(q)||r.url.toLowerCase().includes(q));
    stat.total+=g.requests.length;
    if(q && !matched.length && !g.name.toLowerCase().includes(q)) return null;
    const list=q?matched:g.requests; stat.shown+=list.length;
    const gEl=el('div','group'+(g.collapsed&&!q?' collapsed':''));
    const head=el('div','group-head');
    head.innerHTML=`<span class="caret">▼</span><span class="gname">${esc(g.name)}</span><span class="gcount">${g.requests.length}</span>`;
    if(g.error){ head.title='解析失败：'+g.error; head.querySelector('.gcount').textContent='!'; }
    else if(g.path){ head.title=g.path; }
    const act=el('span','gact');
    const ren=el('button','x','✎'); ren.title=DOCS.enabled&&g.path?'重命名 .http 文件':'重命名'; ren.onclick=e=>{e.stopPropagation();renameGroup(g);};
    const del=el('button','x','🗑'); del.title=DOCS.enabled&&g.path?'删除 .http 文件':'删除分组'; del.onclick=e=>{e.stopPropagation();deleteGroup(g);};
    act.append(ren,del); head.appendChild(act);
    head.onclick=()=>{ g.collapsed=!g.collapsed; if(g.path){ ui.collapsed=ui.collapsed||{}; ui.collapsed[g.path]=g.collapsed; } persist(); renderSidebar(); };
    /* 分组头作为投放目标：拖到这里 = 追加到该分组末尾（折叠状态下松手会自动展开） */
    head.addEventListener('dragover',e=>{ if(!dragRid) return; e.preventDefault(); e.dataTransfer.dropEffect='move'; head.classList.add('drop-on'); });
    head.addEventListener('dragleave',e=>{ if(!head.contains(e.relatedTarget)) head.classList.remove('drop-on'); });
    head.addEventListener('drop',e=>{ if(!dragRid) return; e.preventDefault(); e.stopPropagation(); head.classList.remove('drop-on'); const rid=dragRid; dragRid=null; moveSaved(rid,g.id,null); });
    gEl.appendChild(head);
    const reqs=el('div','reqs');
    /* 分组空白区 / 空分组：追加到末尾 */
    reqs.addEventListener('dragover',e=>{ if(!dragRid) return; e.preventDefault(); e.dataTransfer.dropEffect='move'; reqs.classList.add('drop-on'); });
    reqs.addEventListener('dragleave',e=>{ if(!reqs.contains(e.relatedTarget)) reqs.classList.remove('drop-on'); });
    reqs.addEventListener('drop',e=>{ if(!dragRid) return; e.preventDefault(); e.stopPropagation(); reqs.classList.remove('drop-on'); const rid=dragRid; dragRid=null; moveSaved(rid,g.id,null); });
    list.forEach(r=>{
      const item=el('div','req-item'+(activeTab()&&activeTab().savedId===r.id?' active':''));
      item.innerHTML=`<span class="mb ${methodColor(r.method)}">${r.method}</span><span class="rn">${esc(r.name)}</span>`;
      const rn=el('button','rx rr','✎'); rn.title='重命名'; rn.onclick=e=>{e.stopPropagation();renameSaved(g,r);};
      const x=el('button','rx','✕'); x.title='删除'; x.onclick=e=>{e.stopPropagation();deleteSaved(g,r);};
      item.append(rn,x); item.onclick=()=>openSaved(r);
      const nameEl=item.querySelector('.rn');
      if(nameEl) nameEl.ondblclick=e=>{ e.stopPropagation(); renameSaved(g,r); };
      /* 拖拽：可在分组间移动 / 组内排序（文件真源下跨文件搬段会丢注释，1.0.1 再做） */
      item.draggable=!DOCS.enabled;
      item.title=DOCS.enabled?'双击重命名':'双击重命名 · 拖拽可移动到其他分组';
      item.addEventListener('dragstart',e=>{ dragRid=r.id; item.classList.add('dragging'); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',r.id); }catch(_){} });
      item.addEventListener('dragend',()=>{ dragRid=null; item.classList.remove('dragging'); $$('#tree .drop-before,#tree .drop-after,#tree .drop-on').forEach(n=>{ n.classList.remove('drop-before','drop-after','drop-on'); }); });
      item.addEventListener('dragover',e=>{ if(!dragRid||dragRid===r.id) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect='move'; const rt=item.getBoundingClientRect(); const after=(e.clientY-rt.top)>rt.height/2; item.classList.toggle('drop-after',after); item.classList.toggle('drop-before',!after); });
      item.addEventListener('dragleave',()=>{ item.classList.remove('drop-before','drop-after'); });
      item.addEventListener('drop',e=>{
        if(!dragRid) return; e.preventDefault(); e.stopPropagation();
        const after=item.classList.contains('drop-after');
        item.classList.remove('drop-before','drop-after');
        const rid=dragRid; dragRid=null;
        if(after){ const next=nextSavedId(g,r.id); if(next) moveSaved(rid,g.id,next); else moveSaved(rid,g.id,null); }
        else moveSaved(rid,g.id,r.id);
      });
      reqs.appendChild(item);
    });
  gEl.appendChild(reqs);
  return gEl;
}

/* ---------- 映射写回 + 文件夹 / 未登记 / 重新定位 ---------- */

async function saveWorkspaceMap(){
  const M=window.POLARIS_MAP;
  if(!M||!DOCS.map||!DOCS.store) return false;
  try{
    const w=await M.save(DOCS.store.host,DOCS.dir,DOCS.map);
    if(!w.ok){ setStatus('写侧栏映射失败：'+(w.reason||'未知'),'warn'); return false; }
    return true;
  }catch(e){ setStatus('写侧栏映射失败：'+((e&&e.message)||e),'warn'); return false; }
}

/* 磁盘上有、映射里没有的 .http（侧栏不显示它们，只给一个入口） */
function mapPending(){
  const M=window.POLARIS_MAP;
  if(!DOCS.map||!M) return [];
  const have={}; M.entries(DOCS.map).forEach(e=>{ have[M.pathKey(M.toAbs(DOCS.dir,e))]=1; });
  return (DOCS.files||[]).filter(f=>!have[M.pathKey(f.path)]);
}

async function addPendingFiles(paths){
  const M=window.POLARIS_MAP;
  if(!M||!DOCS.map) return 0;
  const have={}; M.entries(DOCS.map).forEach(e=>{ have[M.pathKey(M.toAbs(DOCS.dir,e))]=1; });
  let n=0;
  (paths||[]).forEach(p=>{
    const entry=M.toEntry(DOCS.dir,p);
    const k=M.pathKey(M.toAbs(DOCS.dir,entry));
    if(have[k]) return;
    have[k]=1; DOCS.map.unfiled.push(entry); n++;
  });
  if(n){ await saveWorkspaceMap(); renderSidebar(); setStatus('已加入 '+n+' 个文件到侧栏','ok'); }
  return n;
}

function openPendingFiles(){
  const pend=mapPending();
  if(!pend.length){ setStatus('没有未登记的文件','ok'); return; }
  const bg=$('#modalBg'); const m=el('div','modal wide');
  m.innerHTML=`<h3>未登记的文件</h3><div class="sub">这些 .http 在资源目录里，但侧栏映射没有登记。加入只写 wpa-workspace.json，文件本身不会被移动或改写。</div>`;
  const list=el('div','pend-list');
  pend.forEach(f=>{
    const row=el('div','pend-row');
    row.innerHTML=`<span class="pend-name">${esc(STORE.baseName(f.path))}</span><span class="pend-path">${esc(f.path)}</span>`;
    const add=el('button','btn sm','加入');
    add.onclick=async()=>{ add.disabled=true; add.textContent='已加入'; await addPendingFiles([f.path]); };
    row.appendChild(add); list.appendChild(row);
  });
  m.appendChild(list);
  const acts=el('div','acts'); const sp=el('div'); sp.style.flex='1';
  const cancel=el('button','btn ghost','关闭'); cancel.onclick=close;
  const all=el('button','btn primary','全部加入');
  all.onclick=async()=>{ await addPendingFiles(pend.map(f=>f.path)); close(); };
  acts.append(sp,cancel,all); m.appendChild(acts);
  function close(){ bg.classList.remove('open'); bg.innerHTML=''; }
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open'); bg.onclick=e=>{ if(e.target===bg) close(); };
}

function newFolderFlow(){
  PD.ask('新建文件夹',{label:'名称',value:'新文件夹',sub:'文件夹只有一层，文件直接挂在里面。排序与归属都写进 wpa-workspace.json。'},async n=>{
    if(n==null) return;
    const M=window.POLARIS_MAP;
    const r=M.addFolder(DOCS.map,n);
    if(!r.ok){ setStatus(r.reason==='EXISTS'?'已有同名文件夹':'文件夹名不能为空','err'); return; }
    DOCS.map=r.map;
    if(await saveWorkspaceMap()){ renderSidebar(); setStatus('已新建文件夹「'+String(n).trim()+'」','ok'); }
  });
}

function renameFolderFlow(f){
  PD.ask('重命名文件夹',{label:'名称',value:f.name},async n=>{
    if(n==null) return;
    const M=window.POLARIS_MAP;
    const r=M.renameFolder(DOCS.map,f.name,n);
    if(!r.ok){ setStatus(r.reason==='EXISTS'?'已有同名文件夹':(r.reason==='EMPTY_NAME'?'名称不能为空':'改不了这个文件夹'),'err'); return; }
    DOCS.map=r.map;
    if(await saveWorkspaceMap()){ renderSidebar(); setStatus('文件夹已重命名','ok'); }
  });
}

function removeFolderFlow(f){
  PD.confirm('删除文件夹「'+f.name+'」？\n里面的 '+f.files.length+' 个文件会退回根，文件本身不会被删除。',async ok=>{
    if(!ok) return;
    const M=window.POLARIS_MAP;
    const r=M.removeFolder(DOCS.map,f.name);
    if(!r.ok){ setStatus('删不掉这个文件夹','err'); return; }
    DOCS.map=r.map;
    if(await saveWorkspaceMap()){ renderSidebar(); setStatus('已删除文件夹，文件退回根','ok'); }
  });
}

function relocateFlow(node){
  const M=window.POLARIS_MAP;
  const reg={}; M.entries(DOCS.map).forEach(e=>{ reg[M.pathKey(M.toAbs(DOCS.dir,e))]=1; });
  const cands=(DOCS.files||[]).filter(f=>!reg[M.pathKey(f.path)]);
  const hint=cands.length
    ? ('目录里有 '+(cands.length)+' 个未登记文件可挑：'+cands.slice(0,3).map(f=>STORE.baseName(f.path)).join('、')+(cands.length>3?'…':''))
    : '填绝对路径；资源目录内的文件也可以填相对路径。';
  PD.ask('重新定位「'+node.name+'」',{label:'新路径',value:node.entry,sub:hint,okText:'定位'},async v=>{
    if(v==null) return;
    const raw=String(v).trim(); if(!raw) return;
    const abs=M.toAbs(DOCS.dir,raw);
    let st;
    try{ st=await DOCS.store.host.stat(abs); }catch(e){ setStatus('检查路径失败：'+((e&&e.message)||e),'err'); return; }
    if(!st||!st.exists){ setStatus('这个路径下没有文件：'+abs,'err'); return; }
    const r=M.relocate(DOCS.map,node.entry,M.toEntry(DOCS.dir,abs));
    if(!r.ok){ setStatus('映射里找不到这条登记','err'); return; }
    DOCS.map=r.map;
    if(await saveWorkspaceMap()){ await refreshDocs(true); renderSidebar(); setStatus('已重新定位到 '+STORE.baseName(abs),'ok'); }
  });
}

function unregisterFlow(node){
  PD.confirm('把「'+node.name+'」从侧栏移除登记？\n只删映射里这一条，文件本身不动；下次点「发现未登记」还能加回来。',async ok=>{
    if(!ok) return;
    const M=window.POLARIS_MAP;
    const r=M.unregister(DOCS.map,node.entry);
    if(!r.ok) return;
    DOCS.map=r.map;
    if(await saveWorkspaceMap()){ renderSidebar(); setStatus('已从侧栏移除登记','ok'); }
  });
}

/* ===================== 环境切换 ===================== */
function renderEnv(){
  const env=curEnv();
  $('#envName').textContent=env?env.name:'无环境';
  $('#envSel').title=env&&env.baseUrl?('baseUrl: '+env.baseUrl):'未选择环境';
  const menu=$('#envMenu'); menu.innerHTML='';
  state.envs.forEach(e=>{
    const b=el('button','env-item'+(e.id===state.activeEnv?' on':''),`<span>${esc(e.name)}</span><small>${esc(e.baseUrl||'(无 baseUrl)')}</small>`);
    b.onclick=()=>{ state.activeEnv=e.id; rememberEnv(e); persist(); renderEnv(); renderRequestBar(); $('#envMenu').classList.remove('open'); setStatus('已切换环境：'+e.name,'ok'); };
    menu.appendChild(b);
  });
  const none=el('button','env-item'+(!state.activeEnv?' on':''),'<span>无环境</span><small>不解析变量</small>');
  none.onclick=()=>{ state.activeEnv=null; rememberEnv(null); persist(); renderEnv(); renderRequestBar(); $('#envMenu').classList.remove('open'); };
  menu.appendChild(none);
  const mng=el('button','env-item manage','<span>⚙ 管理环境与变量…</span>'); mng.onclick=()=>{ $('#envMenu').classList.remove('open'); openEnvManager(); };
  menu.appendChild(mng);
  const to=el('button','env-item manage','<span>⏱ 请求超时：'+esc(fmtTimeout(ui.timeoutMs))+'</span>'); to.onclick=()=>{ $('#envMenu').classList.remove('open'); openTimeoutSettings(); };
  menu.appendChild(to);
}
function openEnvManager(){
  const bg=$('#modalBg'); const m=el('div','modal wide');
  let selId=state.activeEnv || (state.envs[0]&&state.envs[0].id);
  function render(){
    const env=state.envs.find(e=>e.id===selId);
    m.innerHTML=`<h3>环境与变量</h3><div class="sub">每个环境含一个请求服务 <b>baseUrl</b>(ip+端口) 与一组变量；在 URL / Header / Body 中用 <b>{{baseUrl}}</b>、<b>{{变量名}}</b> 引用，发送时解析。</div>`;
    const tabs=el('div','env-tabs');
    state.envs.forEach(e=>{ const b=el('button','env-tab'+(e.id===selId?' on':''),esc(e.name)+(e.id===state.activeEnv?' ●':'')); b.onclick=()=>{selId=e.id;render();}; tabs.appendChild(b); });
    const add=el('button','env-tab add','＋ 新建环境'); add.onclick=()=>{ const ne={id:uid(),name:'环境 '+(state.envs.length+1),baseUrl:'',vars:[blankRow()]}; state.envs.push(ne); selId=ne.id; render(); };
    tabs.appendChild(add); m.appendChild(tabs);
    if(env){
      const f1=el('div','field'); f1.innerHTML='<label>环境名称</label>'; const i1=el('input'); i1.value=env.name; i1.oninput=()=>env.name=i1.value; f1.appendChild(i1); m.appendChild(f1);
      const f2=el('div','field'); f2.innerHTML='<label>请求服务 baseUrl（ip + 端口）</label>'; const i2=el('input'); i2.placeholder='http://127.0.0.1:8080'; i2.value=env.baseUrl||''; i2.oninput=()=>env.baseUrl=i2.value; f2.appendChild(i2); m.appendChild(f2);
      const f3=el('div','field'); f3.innerHTML='<label>变量</label>'; const host=el('div','env-vars'); if(!env.vars)env.vars=[blankRow()]; host.appendChild(kvEditor(env.vars,{kPlace:'变量名',vPlace:'值',onChange:()=>{}})); f3.appendChild(host); m.appendChild(f3);
    }else m.appendChild(el('div','field','还没有环境，点「＋ 新建环境」。'));
    const acts=el('div','acts');
    if(env){ const del=el('button','btn ghost danger','删除'); del.onclick=()=>{ PD.confirm('确定删除环境「'+env.name+'」？',ok=>{ if(!ok)return; state.envs=state.envs.filter(e=>e.id!==env.id); if(state.activeEnv===env.id)state.activeEnv=state.envs[0]?state.envs[0].id:null; selId=state.envs[0]&&state.envs[0].id; render(); }); }; acts.appendChild(del); }
    const sp=el('div'); sp.style.flex='1'; acts.appendChild(sp);
    if(env){ const use=el('button','btn',env.id===state.activeEnv?'✓ 当前环境':'设为当前'); use.onclick=()=>{ state.activeEnv=selId; rememberEnv(state.envs.find(e=>e.id===selId)); persist(); saveEnvsToFile(); renderEnv(); renderRequestBar(); render(); }; acts.appendChild(use); }
    const done=el('button','btn primary','完成'); done.onclick=close; acts.appendChild(done);
    m.appendChild(acts);
  }
  function close(){ state.envs.forEach(e=>{ if(e.vars)e.vars=e.vars.filter(r=>r.k||r.v); }); rememberEnv(curEnv()); persist(); saveEnvsToFile(); renderEnv(); renderRequestBar(); bg.classList.remove('open'); bg.innerHTML=''; }
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open'); bg.onclick=e=>{if(e.target===bg)close();};
  render();
}

/* 超时配置：全局默认（持久化 ui.timeoutMs），独立窗口 fetch 路径由 AbortController 执行等价超时 */
function fmtTimeout(ms){
  if(ms==null) return '';
  if(ms<=0) return '无限制';
  return (ms/1000)+' 秒';
}
function timeoutOptions(){
  return [
    {label:'无限制（宿主护栏约 900s）', ms:0},
    {label:'15 秒', ms:15000},
    {label:'30 秒', ms:30000},
    {label:'60 秒', ms:60000},
    {label:'120 秒（默认）', ms:120000},
    {label:'300 秒', ms:300000},
  ];
}
function openTimeoutSettings(){
  const bg=$('#modalBg'); const m=el('div','modal');
  m.innerHTML='<h3>请求超时设置</h3><div class="sub">发送请求最长等待时间。面板模式经宿主 cap.http 直发，受宿主 900s（约 15 分钟）总护栏约束；「无限制」实际等待上限仍为 900s。</div>';
  const opts=timeoutOptions();
  const f=el('div','field'); f.innerHTML='<label>超时</label>';
  const sel=el('select');
  // 预置选项；若当前值不在预置中，追加一个「自定义」占位显示（不改动用户值，保存时若未改动维持原值）
  if(!opts.some(o=>o.ms===ui.timeoutMs)){
    const op=el('option'); op.value=String(ui.timeoutMs); op.textContent='自定义 '+(ui.timeoutMs>0?(ui.timeoutMs/1000)+' 秒':'无限制'); sel.appendChild(op);
  }
  opts.forEach(o=>{ const op=el('option'); op.value=o.ms; op.textContent=o.label; sel.appendChild(op); });
  sel.value=String(ui.timeoutMs);
  f.appendChild(sel); m.appendChild(f);
  // 说明当前生效值
  const cur=el('div','sub'); cur.style.cssText='padding-top:0'; cur.innerHTML='当前值：<b>'+fmtTimeout(ui.timeoutMs)+'</b>';
  m.appendChild(cur);
  const acts=el('div','acts'); const sp=el('div'); sp.style.flex='1';
  const reset=el('button','btn ghost','恢复默认 120s'); reset.title='120 秒';
  reset.onclick=()=>{ ui.timeoutMs=120000; persist(); renderEnv(); close(); setStatus('请求超时已恢复默认 120 秒','ok'); };
  const ok=el('button','btn primary','保存'); ok.onclick=()=>{ const v=Number(sel.value); if(v!==ui.timeoutMs){ ui.timeoutMs=v; persist(); setStatus('请求超时已设为 '+fmtTimeout(v),'ok'); } close(); };
  acts.append(reset,sp,ok); m.appendChild(acts);
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open');
  bg.onclick=e=>{ if(e.target===bg)close(); };
  function close(){ bg.classList.remove('open'); bg.innerHTML=''; }
}
/* ===================== tab 条 ===================== */
// 新建 tab 时置 true：新 tab unshift 到头部，需滚动到最左让用户看到；
// 其余场景（点击/关闭/保存等）应恢复重建前的滚动位置，避免整条 tab 栏跳回开头。
let _resetTabScroll=false;
function renderTabs(){
  const bar=$('#tabbar');
  const prevScroll=bar.scrollLeft;   // 重建会重置 scrollLeft，先记录点击前位置
  bar.innerHTML='';
  // 加号钉在左缘（position:sticky），先插入使其位于滚动起点
  const add=el('button','tab-add','+'); add.title='新建请求 tab'; add.onclick=()=>{ const nt=newTab(); state.tabs.unshift(nt); state.activeTab=nt.id; _resetTabScroll=true; renderAll(); persist(); };
  bar.appendChild(add);
  state.tabs.forEach(t=>{
    const tab=el('div','rtab'+(t.id===state.activeTab?' active':''));
    tab.innerHTML=`<span class="tm ${methodColor(t.method)}">${t.method}</span><span class="tn">${esc(t.name)}</span>`;
    if(t.docConflict){
      const w=el('span','conflict','⚠');
      w.title='磁盘上的这一段被外部改过，点这里处理';
      w.onclick=e=>{ e.stopPropagation(); state.activeTab=t.id; if(t.docConflict) t.docConflict.dismissed=false; renderAll(); persist(); };
      tab.appendChild(w);
    }
    if(t.dirty) tab.appendChild(el('span','dirty'));
    const x=el('button','tx','×'); x.title='关闭'; x.onclick=e=>{e.stopPropagation();closeTab(t);}; tab.appendChild(x);
    tab.onclick=()=>{ state.activeTab=t.id; renderAll(); persist(); };
    tab.oncontextmenu=e=>{ e.preventDefault(); e.stopPropagation(); showTabCtxMenu(e,t); };
    tab.querySelector('.tn').ondblclick=e=>{ e.stopPropagation(); PD.ask('重命名 tab',{value:t.name},n=>{ if(n!=null){ t.name=n.trim()||t.name; renderTabs(); persist(); } }); };
    bar.appendChild(tab);
  });
  // 新 tab 回到左缘，确保可见（加号 stick 后滚动起点即在窗口最左）；
  // 其他操作（点击/关闭/保存等）恢复重建前位置，避免点靠后 tab 时整条跳回开头。
  if(_resetTabScroll){ bar.scrollLeft=0; _resetTabScroll=false; }
  else if(prevScroll) bar.scrollLeft=prevScroll;
  updateTabFade();
  $('#stTabs').textContent=state.tabs.length;
}
/* 右缘溢出遮罩：有未滚出的 tab 时亮起（隐藏滚动条下的唯一"还有更多"提示） */
function updateTabFade(){
  const bar=$('#tabbar'); if(!bar) return;
  bar.classList.toggle('has-more', bar.scrollLeft+bar.clientWidth < bar.scrollWidth-1);
}

/* ===================== 请求栏 ===================== */
function renderRequestBar(){
  const t=activeTab();
  const lbl=$('#methodLabel'); lbl.textContent=t.method; lbl.className=methodColor(t.method);
  const urlIn=$('#url'); if(document.activeElement!==urlIn) urlIn.value=t.url;
  updateResolvedPreview();
}
function updateResolvedPreview(){
  const t=activeTab(); const box=$('#urlResolved');
  if(t.url && t.url.indexOf('{{')>=0){ const r=resolveVars(t.url,t); box.innerHTML='→ <b>'+esc(r)+'</b>'; }
  else box.innerHTML='';
}

/* ===================== 请求编辑区 ===================== */
const countRows = rows => rows.filter(r=>r.on&&(r.k||r.v)).length;
function renderReqEditor(){
  const t=activeTab();
  $$('#reqSubtabs .subtab').forEach(b=>b.classList.toggle('active',b.dataset.rt===t.reqTab));
  $('#bParams').textContent=countRows(t.params)||'';
  $('#bHeaders').textContent=countRows(t.headers)||'';
  $('#bBody').textContent=t.bodyType!=='none'?'•':'';
  const pane=$('#reqPane'); pane.innerHTML='';
  if(t.reqTab==='params'){
    pane.appendChild(kvEditor(t.params,{kPlace:'参数名',vPlace:'参数值',onChange:()=>{ markDirty(t); syncParamsToUrl(t); $('#bParams').textContent=countRows(t.params)||''; persist(); }}));
  }else if(t.reqTab==='headers'){
    pane.appendChild(kvEditor(t.headers,{kPlace:'Header 名',vPlace:'Header 值',onChange:()=>{ markDirty(t); $('#bHeaders').textContent=countRows(t.headers)||''; persist(); }}));
  }else renderBodyEditor(pane,t);
}
function kvEditor(rows,opts){
  const wrap=el('div','kv');
  function ensureBlank(){ if(!rows.length || rows[rows.length-1].k || rows[rows.length-1].v) rows.push(blankRow()); }
  function rowEl(r){
    const isLast=()=>rows[rows.length-1]===r;
    const row=el('div','kv-row'+((!r.k&&!r.v)?' blank':''));
    const ck=el('label','ck'); const cb=el('input'); cb.type='checkbox'; cb.checked=r.on; cb.onchange=()=>{r.on=cb.checked;opts.onChange();}; ck.appendChild(cb);
    const ki=el('input','k'); ki.type='text'; ki.placeholder=opts.kPlace; ki.value=r.k; ki.spellcheck=false;
    const vi=el('input','v'); vi.type='text'; vi.placeholder=opts.vPlace; vi.value=r.v; vi.spellcheck=false;
    const onInput=()=>{ r.k=ki.value; r.v=vi.value; row.classList.toggle('blank',!r.k&&!r.v); if((r.k||r.v)&&isLast()){ const nr=blankRow(); rows.push(nr); wrap.appendChild(rowEl(nr)); } opts.onChange(); };
    ki.addEventListener('input',onInput); vi.addEventListener('input',onInput);
    const rm=el('button','rm','✕'); rm.title='删除该行'; rm.onclick=()=>{ const i=rows.indexOf(r); if(i>-1)rows.splice(i,1); rebuild(); opts.onChange(); };
    row.append(ck,ki,vi,rm); return row;
  }
  function rebuild(){ wrap.innerHTML=''; ensureBlank(); rows.forEach(r=>wrap.appendChild(rowEl(r))); }
  rebuild(); return wrap;
}
function renderBodyEditor(pane,t){
  const bar=el('div','body-bar'); const seg=el('div','seg');
  [['none','无'],['json','JSON'],['text','文本'],['form','Form']].forEach(([v,l])=>{ const b=el('button',t.bodyType===v?'on':'',l); b.onclick=()=>{ t.bodyType=v; markDirty(t); persist(); renderReqEditor(); }; seg.appendChild(b); });
  bar.appendChild(seg); bar.appendChild(el('div','sp'));
  if(t.bodyType==='json'){ const fmt=el('button','tool','格式化'); fmt.onclick=()=>{ try{ t.body=JSON.stringify(JSON.parse(t.body),null,2); renderReqEditor(); persist(); setStatus('JSON 已格式化','ok'); }catch(e){ setStatus('JSON 无效：'+e.message,'err'); } }; bar.appendChild(fmt); }
  pane.appendChild(bar);
  if(t.bodyType==='none'){ pane.appendChild(el('div','body-none','该请求没有 Body。<br>选择 JSON / 文本 / Form 以编辑请求体。')); }
  else if(t.bodyType==='form'){ const host=el('div'); host.style.cssText='height:calc(100% - 49px);overflow:auto'; host.appendChild(kvEditor(t.formBody,{kPlace:'字段名',vPlace:'字段值',onChange:()=>{markDirty(t);persist();}})); pane.appendChild(host); }
  else{
    const ta=el('textarea','code'); ta.spellcheck=false; ta.placeholder=t.bodyType==='json'?'{\n  "key": "value"\n}':'原始请求体…'; ta.value=t.body; ta.style.height='calc(100% - 49px)';
    ta.addEventListener('input',()=>{ t.body=ta.value; markDirty(t); persist(); });
    ta.addEventListener('keydown',e=>{ if(e.key==='Tab'){ e.preventDefault(); const s=ta.selectionStart,en=ta.selectionEnd; ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(en); ta.selectionStart=ta.selectionEnd=s+2; t.body=ta.value; } });
    pane.appendChild(ta);
  }
}
function syncParamsToUrl(t){
  const [base]=splitUrl(t.url);
  const qs=t.params.filter(r=>r.on&&r.k).map(r=>encodeURIComponent(r.k)+'='+encodeURIComponent(r.v)).join('&');
  t.url = qs? base+'?'+qs : base;
  const urlIn=$('#url'); if(document.activeElement!==urlIn) urlIn.value=t.url;
  updateResolvedPreview();
}
function syncUrlToParams(t){
  const [,query]=splitUrl(t.url); const rows=[];
  if(query) query.split('&').forEach(p=>{ if(!p)return; const [k,...rest]=p.split('='); rows.push({id:uid(),on:true,k:decodeURIComponent(k||''),v:decodeURIComponent((rest.join('=')||'').replace(/\+/g,' '))}); });
  rows.push(blankRow()); t.params=rows;
}

/* ===================== 发送 ===================== */
async function send(){
  const t=activeTab();
  const seq=(t.sendSeq||0)+1;              // 竞态守卫序号：迟到响应不得覆盖新请求/已中断状态
  t.sendSeq=seq;
  t.stopped=false;                       // 新发送重置中断标记
  if(t.abortCtl) t.abortCtl.abort();     // 清理上个 in-flight（若还在）
  let url=resolveVars(t.url.trim(),t);
  if(!url){ setStatus('请先输入 URL','warn'); $('#url').focus(); return; }
  if(!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(url)) url='https://'+url;
  const headers={}; t.headers.filter(r=>r.on&&r.k).forEach(r=>headers[resolveVars(r.k,t)]=resolveVars(r.v,t));
  // DBX 沙箱纯 fetch 直连：无 cap.http 宿主直发、无本地中继代理。
  // 禁发头（Cookie/UA/Referer 等 forbidden headers）会被浏览器静默剥离，UI 无感知丢失。
  // 不再硬拦截——改为发送后若失败提示可能原因；用户可去掉这些头或接受丢失。
  const strippedHeaders=Object.keys(headers).filter(k=>BROWSER_STRIP.test(k));
  t.strippedHeaders=strippedHeaders;
  let body; const method=t.method;
  if(!['GET','HEAD'].includes(method)){
    if(t.bodyType==='json'){ body=resolveVars(t.body,t); if(!Object.keys(headers).some(h=>h.toLowerCase()==='content-type')) headers['Content-Type']='application/json'; }
    else if(t.bodyType==='text'){ body=resolveVars(t.body,t); }
    else if(t.bodyType==='form'){ body=t.formBody.filter(r=>r.on&&r.k).map(r=>encodeURIComponent(resolveVars(r.k,t))+'='+encodeURIComponent(resolveVars(r.v,t))).join('&'); if(!Object.keys(headers).some(h=>h.toLowerCase()==='content-type')) headers['Content-Type']='application/x-www-form-urlencoded'; }
  }
  // 超时：全局 ui.timeoutMs（默认 120s）；`0` = 无限制（fetch 不设 timer）
  const tmo = (typeof ui.timeoutMs==='number' && Number.isFinite(ui.timeoutMs)) ? ui.timeoutMs : 120000;
  const btn=$('#sendBtn');
  // 发送态：按钮变为可点击的「■ 停止」
  btn.classList.add('stop-mode'); btn.disabled=false;
  btn.innerHTML='<span class="stop-ico"></span> 停止';
  btn.title='停止请求';
  $('#resSubtabs').style.display='none'; $('#resStatus').style.display='none'; $('#resTools').style.display='none';
  $('#resPane').innerHTML='<div class="res-loading"><span class="spin"></span> 请求发送中…<span class="wait-tick" id="waitTick"></span></div>';
  setStatus(method+' '+url+' …');
  const t0=performance.now();
  // 等待计时
  const tick=setInterval(()=>{ const el=$('#waitTick'); if(el) el.textContent=' · 已等待 '+ms(performance.now()-t0); },1000);

  // 停止处理：只有 seq 匹配（未发生新发送）才生效
  const doStop=()=>{
    if(t.sendSeq!==seq) return;               // 已被新请求覆盖，忽略
    t.sendSeq++;                               // 推进序号，废止在途回调
    t.stopped=true;
    clearInterval(tick);
    if(t.abortCtl){ t.abortCtl.abort(); t.abortCtl=null; }
    btn.classList.remove('stop-mode'); btn.disabled=false; btn.innerHTML='发送 <span class="k">⌘↵</span>'; btn.title='';
    btn.onclick=send;
    $('#resPane').innerHTML=`<div class="res-err"><div class="ti">⏹ 已手动中断</div><div>请求已停止。<span style="color:var(--dimmer)">sidecar 原生请求仍在后台继续，UI 已丢弃响应（逻辑中断）。</span></div><div style="margin-top:10px;color:var(--dimmer);font-size:11px">耗时 ${ms(performance.now()-t0)} · ${esc(url)}</div></div>`;
    setStatus('请求已中断 · '+ms(performance.now()-t0),'err');
  };
  btn.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); doStop(); };

  const abortCtl = (typeof AbortController!=='undefined') ? new AbortController() : null;
  t.abortCtl=abortCtl;
  try{
    let resp;
    {
      // sidecar 模式：经 dbxPlugin.invoke('http/request') 调本插件原生 backend 发送。
      // 原生进程用 reqwest 发请求，无 CORS/混合内容/禁发头限制，等效 cURL。
      // 停止按钮为逻辑中断：invoke 是同步 RPC 无法取消，请求继续在 sidecar 跑，
      // UI 用 sendSeq 守卫丢弃迟到响应（与原版 cap.http 面板模式同范式）。
      const r = await DBX.invoke('http/request', {
        method, url, headers,
        body: body || '',
        bodyType: t.bodyType || 'text',
        timeoutMs: tmo > 0 ? tmo : 86400000,
      });
      if (t.stopped || t.sendSeq !== seq) return;
      const ct = r.contentType || '';
      const isBin = BINARY.test(ct) || !!r.isBase64;
      const text = r.body || '';
      let blobUrl = null;
      if (isBin && r.isBase64 && text) { const blob = b64ToBlob(text, ct); if (blob) blobUrl = URL.createObjectURL(blob); }
      const parsed = isBin ? { ok: false } : tryJSON(text);
      const t1 = performance.now();
      resp = {
        status: r.status, statusText: r.statusText || '', ok: !!r.ok,
        timeMs: r.timeMs || (t1 - t0), size: r.size || respSize(ct, text, r.isBase64) || 0,
        contentType: ct, headers: r.headers || {}, text, isBinary: isBin, blobUrl, url,
        parsed: parsed.ok ? parsed.value : undefined,
        sse: !!r.sse, sseTruncated: !!r.sseTruncated,
      };
    }
    if(t.stopped||t.sendSeq!==seq){ if(resp&&resp.blobUrl) URL.revokeObjectURL(resp.blobUrl); return; }  // 在途响应丢弃
    t.response=resp;
    /* 供 {{请求名.response.body.$.x}} 跨请求引用：按 tab 名记一份，同名以最后一次为准 */
    try{ RESP_CACHE[t.name]={ status:resp.status, headers:resp.headers||{}, text:resp.text||'', parsed:resp.parsed }; }catch(e){}
    /* v0.3.0：发送成功后交给 .http 工作区自动落盘（异步，失败不影响主流程） */
    if(window.POLARIS_HTTP_WS && window.POLARIS_HTTP_WS.onResponse){
      try{ window.POLARIS_HTTP_WS.onResponse(t,resp,{method:method,url:url,headers:headers,body:body}); }catch(e){}
    }
    t.respPath=''; t.respFilter=''; t.tableSel=null; t.colW={}; t.treeOpen='auto'; t.hiddenCols={}; t.sort={};
    t.respView = resp.parsed!==undefined ? (Array.isArray(resp.parsed)?'table':'object') : /text\/html/i.test(resp.contentType)?'preview' : (resp.isBinary&&/^image\//i.test(resp.contentType))?'preview':'raw';
    renderResponse();
    setStatus(method+' '+resp.status+' '+resp.statusText+' · '+ms(resp.timeMs)+' · '+bytes(resp.size), resp.ok?'ok':'warn');
  }catch(err){
    if(t.stopped||t.sendSeq!==seq) return;   // 停止/被覆盖：吞吐异常
    const t1=performance.now(); t.response={error:err.message||String(err),timeMs:t1-t0,url}; renderResponse();
    setStatus('请求失败：'+(err.message||err),'err');
  }finally{
    clearInterval(tick);
    if(btn.classList.contains('stop-mode')){
      btn.classList.remove('stop-mode'); btn.disabled=false; btn.innerHTML='发送 <span class="k">⌘↵</span>'; btn.title='';
    }
    // 还原 onClick：绑定事件的 sendBtn 由 bindEvents 原生挂载，重启避免残留 stop 接管
    const sb=$('#sendBtn'); if(sb){ sb.onclick=send; }
    if(t.abortCtl===abortCtl) t.abortCtl=null;
  }
}

/* ===================== 路径下钻（响应态） ===================== */
function getDrilled(t){
  const r=t.response; const root=r&&!r.error?r.parsed:undefined;
  let data=root, drillErr=false;
  if(t.respPath && root!==undefined){ const g=getByPath(root,t.respPath); if(g.ok) data=g.value; else {drillErr=true; data=undefined;} }
  const hasJSON=data!==undefined;
  const canTable=hasJSON && (Array.isArray(data) || (data&&typeof data==='object'));
  const canPrev = !!r && !t.respPath && (/text\/html/i.test(r.contentType)||/^image\//i.test(r.contentType));
  return {data,drillErr,hasJSON,canTable,canPrev};
}
/** 收集当前钻取数据的顶层字段名（用于过滤栏提示） */
function apiResponseFields(data){
  if(!data) return [];
  if(Array.isArray(data)&&data.length&&data[0]&&typeof data[0]==='object'&&!Array.isArray(data[0])) return Object.keys(data[0]);
  if(data&&typeof data==='object'&&!Array.isArray(data)) return Object.keys(data);
  return [];
}

/* ===================== 响应渲染 ===================== */
function renderResponse(){
  const t=activeTab(); const r=t.response;
  const pane=$('#resPane'),sub=$('#resSubtabs'),sb=$('#resStatus'),tools=$('#resTools');
  if(!r){ sub.style.display='none'; sb.style.display='none'; tools.style.display='none';
    pane.innerHTML='<div class="res-idle"><div class="big">准备就绪</div>输入 URL 点「发送」，或从左侧集合载入一个请求。</div>'; return; }
  if(r.error){ sub.style.display='none'; sb.style.display='none'; tools.style.display='none';
    const netHint=/Failed to fetch|NetworkError|load failed|send:|connect|dns|timeout|timed out/i.test(r.error);
    pane.innerHTML=`<div class="res-err"><div class="ti">⚠ 请求失败</div><div>${esc(r.error)}</div>`+
      (netHint?`<div class="hintbox"><b>可能原因：</b>目标无响应、DNS 解析失败、连接被拒、TLS 握手失败或超时。<br>请求经 sidecar 原生 reqwest 发送（无 CORS/混合内容限制），若失败多为目标侧或网络问题。${t.strippedHeaders&&t.strippedHeaders.length?`<br><b>禁发头：</b>本次含 <code>${esc(t.strippedHeaders.join(', '))}</code>，sidecar 原生发送会完整携带（不会被剥离）。`:''}</div>`:'')+
      `<div style="margin-top:10px;color:var(--dimmer);font-size:11px">耗时 ${ms(r.timeMs)} · ${esc(r.url)}</div></div>`; return; }
  sb.style.display='flex';
  const cls=r.status>=500?'s5':r.status>=400?'s4':r.status>=300?'s3':'s2'; const color=`var(--${cls})`;
  sb.innerHTML=`<span class="status-chip" style="color:${color}"><span class="dotc" style="background:${color}"></span>${r.status} ${esc(r.statusText)}</span>`+
    `<span class="res-meta"><span>耗时 <b>${ms(r.timeMs)}</b></span><span>大小 <b>${bytes(r.size)}</b></span>`+(r.contentType?`<span>类型 <b>${esc(r.contentType.split(';')[0])}</b></span>`:'')+(r.sse?`<span title="SSE 长连接：读满 10 秒或对端断开就收尾，已收到的内容原样显示">SSE <b>${r.sseTruncated?'已截断':'已结束'}</b></span>`:'')+`</span>`;
  sub.style.display='flex';
  // 工具栏（路径下拉 + 手动 + 过滤）
  const baseHasJSON = r.parsed!==undefined;
  if(baseHasJSON){
    tools.style.display='flex';
    tools.innerHTML='';
    let pi=null;
    // 路径下拉（自动识别）
    const pths=collectPaths(r.parsed);
    const ddWrap=el('div','ti path'); ddWrap.innerHTML='<span class="lbl">路径</span>';
    const dd=el('div','pathdd');
    const ddBtn=el('button','pathdd-btn'); ddBtn.type='button';
    const setLbl=()=>{ ddBtn.innerHTML=`<span>${t.respPath?esc(t.respPath):'选择路径'}</span><span class="pcar">▼</span>`; };
    setLbl();
    const menu=el('div','path-menu');
    const fbox=el('input','path-filter'); fbox.placeholder='过滤路径 / 输入后回车应用'; fbox.spellcheck=false;
    const list=el('div','path-list');
    const apply=p=>{ t.respPath=p; if(pi)pi.value=p; persist(); setLbl(); menu.classList.remove('open'); renderRespBody(); };
    const fill=()=>{ list.innerHTML=''; const kw=fbox.value.toLowerCase().trim(); let n=0;
      pths.forEach(p=>{ if(n>=200)return; const lab=p.path===''?'(根)':p.path; if(kw&&!lab.toLowerCase().includes(kw))return; n++;
        const o=el('button','path-opt'+(p.path===t.respPath?' on':'')); o.type='button';
        o.innerHTML=`<span class="pp">${esc(lab)}</span><span class="pk ${p.kind}">${p.kind==='array'?'[ ] '+p.count:p.kind==='object'?'{ } '+p.count:'·'}</span>`;
        o.onclick=()=>apply(p.path); list.appendChild(o); });
      if(!n) list.innerHTML='<div class="path-empty">无匹配路径。<br>回车可直接应用输入的路径。</div>'; };
    fbox.addEventListener('input',fill);
    fbox.addEventListener('keydown',e=>{ if(e.key==='Enter') apply(fbox.value.trim()); if(e.key==='Escape') menu.classList.remove('open'); });
    ddBtn.onclick=e=>{ e.stopPropagation(); const willOpen=!menu.classList.contains('open'); $$('.path-menu').forEach(x=>x.classList.remove('open')); $('#methodMenu').classList.remove('open'); $('#envMenu').classList.remove('open'); if(willOpen){ menu.classList.add('open'); fbox.value=''; fill(); setTimeout(()=>fbox.focus(),0); } };
    menu.addEventListener('click',e=>e.stopPropagation());
    menu.append(fbox,list); dd.append(ddBtn,menu); ddWrap.appendChild(dd);
    // 手动输入（保留，供精确路径与快捷测试）
    const man=el('div','ti manual'); man.innerHTML='<span class="lbl">手动</span>'; pi=el('input'); pi.id='respPathIn'; pi.placeholder='如 data.items[0].name'; pi.value=t.respPath||''; pi.spellcheck=false;
    pi.addEventListener('input',()=>{ t.respPath=pi.value; persist(); setLbl(); renderRespBody(); }); man.appendChild(pi);
    // 过滤（增强版，支持字段匹配语法）
    const drilled=getDrilled(t);
    const apiFields=apiResponseFields(drilled.data);
    const flt=filterBar(t,()=>{ persist(); renderRespBody(); },apiFields);
    tools.append(ddWrap,man,flt);
  }else tools.style.display='none';
  $('#bResH').textContent=Object.keys(r.headers||{}).length||'';
  renderRespBody();
}
function renderRespBody(){
  const t=activeTab(); const r=t.response; if(!r||r.error) return;
  const d=getDrilled(t);
  const caps={table:d.canTable,object:d.hasJSON,raw:true,preview:d.canPrev,headers:true};
  if(!caps[t.respView]) t.respView=d.hasJSON?'object':(d.canPrev?'preview':'raw');
  $$('#resSubtabs .subtab').forEach(b=>{ const v=b.dataset.rv; b.classList.toggle('active',v===t.respView); b.classList.toggle('disabled',!caps[v]); if(v==='preview') b.style.display=d.canPrev?'':'none'; });
  const isT=t.respView==='table', isO=t.respView==='object', isR=t.respView==='raw';
  const pretty=t.prettyCells!==false;
  $('#prettyBtn').style.display=(isT||isO)?'':'none'; $('#prettyBtn').style.color=pretty?'var(--brand)':''; $('#prettyBtn').innerHTML=pretty?'✦ 美化':'✦ 原始';
  $('#treeExpand').style.display=isO?'':'none'; $('#treeCollapse').style.display=isO?'':'none';
  $('#wrapBtn').style.display=isR?'':'none';
  const pane=$('#resPane'); pane.innerHTML='';
  if(d.drillErr){ pane.innerHTML='<div class="prev-none">路径 <b>'+esc(t.respPath)+'</b> 在响应中不存在。</div>'; return; }
  const v=t.respView;
  if(v==='raw') pane.appendChild(viewRaw(r,d.data));
  else if(v==='object') pane.appendChild(viewObject(d.data,t));
  else if(v==='table') pane.appendChild(viewTable(d.data,t));
  else if(v==='preview') pane.appendChild(viewPreview(r));
  else pane.appendChild(viewHeaders(r));
}

/* ---- 预览 / Headers ---- */
function viewPreview(r){
  if(/^image\//i.test(r.contentType)&&r.blobUrl){ const w=el('div','prev-img-wrap'); const img=el('img'); img.src=r.blobUrl; w.appendChild(img); return w; }
  if(/text\/html/i.test(r.contentType)){ const f=el('iframe','prev-frame'); f.sandbox=''; f.srcdoc=r.text; return f; }
  return el('div','prev-none','无可预览内容（仅支持 HTML 与图片预览）。');
}
function viewHeaders(r){
  const wrap=el('div','tbl-wrap'); const tbl=el('table','dt'); const keys=Object.keys(r.headers||{});
  tbl.innerHTML='<thead><tr><th>Header</th><th>Value</th></tr></thead>'; const tb=el('tbody');
  if(!keys.length) tb.innerHTML='<tr><td colspan="2" style="color:var(--dimmer)">（无可见响应头 — 浏览器可能限制了部分头）</td></tr>';
  keys.forEach(k=>{ const tr=el('tr'); tr.innerHTML=`<td style="color:var(--j-key);white-space:nowrap">${esc(k)}</td><td>${esc(r.headers[k])}</td>`; tb.appendChild(tr); });
  tbl.appendChild(tb); wrap.appendChild(tbl); return wrap;
}

/* ===================== cURL：导入 + 导出 ===================== */
/* parseCurl/tokenizeCurl/toCurl/shortUrl/splitUrl 抽离至 curl.js（window.POLARIS_CURL），此处仅保留 UI 编排 */
function openCurlImport(){
  const bg=$('#modalBg'); const m=el('div','modal');
  m.innerHTML='<h3>导入 cURL</h3><div class="sub">粘贴一条 curl 命令，解析为新的请求 tab（支持 -X -H -d --data-raw -u -b -G --json、--flag=value 等号写法、curl.exe 前缀）。</div>';
  const f=el('div','field'); f.innerHTML='<label>cURL 命令</label>'; const ta=el('textarea','curl-ta'); ta.placeholder="curl 'https://api.example.com/users' -H 'Authorization: Bearer xxx' -H 'Content-Type: application/json' --data-raw '{\"a\":1}'"; f.appendChild(ta); m.appendChild(f);
  const acts=el('div','acts'); const sp=el('div'); sp.style.flex='1';
  const c=el('button','btn ghost','取消'); c.onclick=close;
  const ok=el('button','btn primary','解析并新建');
  ok.onclick=()=>{ const txt=ta.value.trim(); if(!txt){ setStatus('请粘贴 curl 命令','warn'); return; }
    try{ const p=parseCurl(txt); if(!p.url){ setStatus('未能从命令中解析出 URL','err'); return; }
      const nt=newTab({ name:'cURL: '+shortUrl(p.url), method:p.method, url:p.url, bodyType:p.bodyType, body:p.body,
        headers:(p.headers.length?p.headers.map(h=>({id:uid(),on:true,k:h.k,v:h.v})):[]).concat([blankRow()]) });
      syncUrlToParams(nt); nt.dirty=true; state.tabs.unshift(nt); state.activeTab=nt.id; renderAll(); persist(); close(); setStatus('已从 cURL 导入：'+p.method+' '+p.url,'ok');
      // 检测禁发头：DBX 沙箱纯直连，这些头会被浏览器静默剥离，主动提醒
      const fb=p.headers.filter(h=>BROWSER_STRIP.test(h.k));
      if(fb.length){
        setStatus('⚠ 导入含浏览器禁发头（'+fb.map(h=>h.k).join(', ')+'）——DBX 直连无法发送这些头，浏览器会静默剥离，目标可能返回 403/登录失效','warn');
      }
    }catch(e){ setStatus('cURL 解析失败：'+e.message,'err'); }
  };
  acts.append(c,sp,ok); m.appendChild(acts);
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open'); ta.focus(); bg.onclick=e=>{if(e.target===bg)close();};
  function close(){ bg.classList.remove('open'); bg.innerHTML=''; }
}

/* ===================== 保存 / 载入 / 分组 ===================== */
function markDirty(t){ if(!t.dirty){ t.dirty=true; renderTabs(); } }
function findSaved(id){ for(const g of state.collections){ const r=g.requests.find(x=>x.id===id); if(r) return {g,r}; } return null; }
function snapshot(t){ return { method:t.method,url:t.url,params:JSON.parse(JSON.stringify(t.params)),headers:JSON.parse(JSON.stringify(t.headers)),bodyType:t.bodyType,body:t.body,formBody:JSON.parse(JSON.stringify(t.formBody)) }; }
async function saveCurrent(){
  const t=activeTab();
  if(t.savedId){ const f=findSaved(t.savedId); if(f){
    /* 文件真源：这一段是从磁盘来的，改完必须落回同一段（段落级替换，别的段不动） */
    if(DOCS.enabled && f.r.httpSource) return saveToDoc(t,f);
    Object.assign(f.r,snapshot(t)); f.r.name=t.name; t.dirty=false;
    persist(); renderTabs(); renderSidebar();
    /* 每次点都给出可见反馈：重复保存不再像「点了没反应」 */
    setStatus('已更新「'+t.name+'」', 'ok');
    toast('已更新「'+esc(t.name)+'」 <b>✓</b>');
    return;
  } }
  if(DOCS.enabled) return saveToDocNew(t);
  const defName=t.url? t.method+' '+shortUrl(t.url):'未命名请求';
  const groupOpts=state.collections.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('');
  const m=openModal('保存请求','把当前请求存入一个分组',[
    {label:'名称',id:'mName',type:'text',value:defName},
    {label:'分组',id:'mGroup',type:'select',html:groupOpts+'<option value="__new">＋ 新建分组…</option>'},
    {label:'新分组名称',id:'mNewGroup',type:'text',value:'新分组'},
  ],vals=>{
    const name=(vals.mName||'').trim()||defName;
    const doSave=g=>{ const r=Object.assign({id:uid(),name:name},snapshot(t)); g.requests.push(r); t.savedId=r.id; t.name=r.name; t.dirty=false; persist(); renderTabs(); renderSidebar(); setStatus('已保存到「'+g.name+'」','ok'); };
    if(vals.mGroup==='__new'||!state.collections.length){
      const gn=(vals.mNewGroup||'').trim();
      if(!gn){ setStatus('请填写新分组名称','err'); return false; }   // 返回 false 保持弹窗
      const g={id:uid(),name:gn,collapsed:false,requests:[]};
      state.collections.push(g); doSave(g); return;
    }
    const g=state.collections.find(x=>x.id===vals.mGroup);
    if(!g){ setStatus('分组已不存在，请重新选择','err'); return false; }
    doSave(g);
  });
  // 新分组输入框：仅当选中「＋ 新建分组…」或无任何分组时显示
  if(m){
    const sel=m.querySelector('#mGroup'), nf=m.querySelector('#mNewGroup'), nfField=nf&&nf.closest('.field');
    const sync=()=>{ if(nfField) nfField.style.display=(!state.collections.length||(sel&&sel.value==='__new'))?'':'none'; };
    if(sel){ sel.addEventListener('change',sync); sync(); if(sel.value==='__new'&&nf) setTimeout(()=>{nf.focus();nf.select&&nf.select();},0); }
  }
}

/* 文件真源下的「新请求」保存：作为一段追加到所选 .http 末尾（一个文件 = 一个 collection） */
async function saveToDocNew(t){
  if(!t.url){ setStatus('请先输入 URL','warn'); return false; }
  if(!state.collections.length){
    const c=await DOCS.store.createCollection('我的接口');
    if(!c.ok){ setStatus('创建 .http 文件失败：'+(c.reason||''),'err'); return false; }
    await registerDocFile(c.path);
    await refreshDocs(true);
  }
  const defName=t.url? t.method+' '+shortUrl(t.url):'未命名请求';
  const fileOpts=state.collections.map(g=>`<option value="${esc(g.path)}">${esc(g.name)}</option>`).join('');
  const m=openModal('保存到 .http','新请求会作为一段写进所选文件末尾（不会重排文件里已有的内容）',[
    {label:'名称',id:'mName',type:'text',value:defName},
    {label:'文件（collection）',id:'mFile',type:'select',html:fileOpts+'<option value="__new">＋ 新建 .http 文件…</option>'},
    {label:'新文件名',id:'mNewFile',type:'text',value:'新集合'},
  ],vals=>{
    const name=(vals.mName||'').trim()||defName;
    if(vals.mFile==='__new'){
      const fn=(vals.mNewFile||'').trim();
      if(!fn){ setStatus('请填写新文件名','err'); return false; }
      appendToDoc(t,vals.mFile,fn,name);
      return;
    }
    appendToDoc(t,vals.mFile,null,name);
  });
  if(m){
    const sel=m.querySelector('#mFile'), nf=m.querySelector('#mNewFile'), nfField=nf&&nf.closest('.field');
    const sync=()=>{ if(nfField) nfField.style.display=(sel&&sel.value==='__new')?'':'none'; };
    if(sel){ sel.addEventListener('change',sync); sync(); }
  }
  return true;
}

/* 追加一段（新建文件时先建再追加）。返回后把 tab 绑到新段上，之后保存就是段落级写回。 */
async function appendToDoc(t,path,newFileName,name){
  let target=path;
  if(newFileName){
    const c=await DOCS.store.createCollection(newFileName);
    if(!c.ok){ setStatus('创建文件失败：'+(c.reason||''),'err'); return; }
    await registerDocFile(c.path);
    target=c.path;
  }
  const req=storeReqFromTab(t); req.name=name; req.title=name;
  let res;
  try{ res=await DOCS.store.appendRequest(target,req); }
  catch(e){ setStatus('写入失败：'+(e.message||e),'err'); return; }
  if(!res.ok){ setStatus('写入失败：'+(res.reason||'')+(res.error?(' · '+res.error):''),'err'); return; }
  t.name=name; t.dirty=false;
  const g=await patchGroup(target);
  if(g&&g.requests[res.index]) setTabDocRef(t,target,g.requests[res.index],g.mtime);
  renderTabs(); renderSidebar();
  setStatus('已写入「'+(g?g.name:STORE.baseName(target))+'」','ok');
  toast('已保存「'+esc(name)+'」 <b>✓</b>');
}

function openSaved(r){
  const exist=state.tabs.find(t=>t.savedId===r.id); if(exist){ state.activeTab=exist.id; renderAll(); return; }
  const t=newTab({ name:r.name,savedId:r.id,method:r.method,url:r.url, params:JSON.parse(JSON.stringify(r.params||[blankRow()])), headers:JSON.parse(JSON.stringify(r.headers||[blankRow()])), bodyType:r.bodyType||'none',body:r.body||'',formBody:JSON.parse(JSON.stringify(r.formBody||[blankRow()])) });
  if(!t.params.length)t.params=[blankRow()]; if(!t.headers.length)t.headers=[blankRow()]; if(!t.formBody.length)t.formBody=[blankRow()];
  if(r.httpSource){
    t.docRef={ file:r.httpSource.file, line:r.httpSource.line, interfaceId:r.interfaceId||null, name:r.name, method:r.method };
    if(r.httpSource.mtime) t.baseMtime=Math.round(r.httpSource.mtime);
  }
  syncTabVars(t);
  state.tabs.unshift(t); state.activeTab=t.id; renderAll(); persist(); setStatus('已载入「'+r.name+'」');
}

function deleteSaved(g,r){
  if(DOCS.enabled && r.httpSource){
    PD.confirm('从文件「'+g.name+'」里删掉请求「'+r.name+'」？\n这一段的文字会从磁盘文件移除，其余段原样保留。',async ok=>{
      if(!ok) return;
      const res=await DOCS.store.deleteRequest(r.httpSource.file,{line:r.httpSource.line,method:r.method,interfaceId:r.httpSource.interfaceId||null},{baseMtime:g.mtime});
      if(!res.ok){ setStatus('删除失败：'+(res.reason||'写入被拒'),'err'); return; }
      state.tabs.forEach(t=>{ if(t.savedId===r.id){t.savedId=null;t.docRef=null;t.dirty=true;} });
      await patchGroup(g.path); renderSidebar(); renderTabs();
      setStatus('已删除「'+r.name+'」','ok');
    });
    return;
  }
  PD.confirm('删除已保存的请求「'+r.name+'」？',ok=>{ if(!ok)return; g.requests=g.requests.filter(x=>x.id!==r.id); state.tabs.forEach(t=>{ if(t.savedId===r.id){t.savedId=null;t.dirty=true;} }); persist(); renderSidebar(); renderTabs(); });
}

function renameGroup(g){
  PD.ask(DOCS.enabled&&g.path?'重命名 .http 文件':'分组名称',{value:g.name},async n=>{
    if(n==null) return;
    const name=(n||'').trim(); if(!name||name===g.name) return;
    if(DOCS.enabled && g.path){
      const r=await DOCS.store.renameCollection(g.path,name);
      if(!r.ok){ setStatus('改名失败：'+(r.reason||'')+(r.reason==='EXISTS'?'（已有同名文件）':''),'err'); return; }
      /* 文件路径变了，先把 tab 的 docRef.file 改过来，否则重扫后会被当成「已消失」 */
      state.tabs.forEach(t=>{ if(t.docRef&&t.docRef.file===g.path) t.docRef.file=r.path; });
      /* 映射里的登记也一起改，否则侧栏会同时出现「新文件未登记 + 旧路径找不到」 */
      const M=window.POLARIS_MAP;
      if(M&&DOCS.map){
        try{
          const mv=M.relocate(DOCS.map,M.toEntry(DOCS.dir,g.path),M.toEntry(DOCS.dir,r.path));
          if(mv.ok){ DOCS.map=mv.map; await M.save(DOCS.store.host,DOCS.dir,DOCS.map); }
        }catch(e){}
      }
      await refreshDocs(true); renderSidebar();
      setStatus('已改名为「'+r.name+'」','ok');
      return;
    }
    g.name=name; persist(); renderSidebar();
  });
}

function renameSaved(g,r){
  PD.ask('重命名请求',{value:r.name},async n=>{
    if(n==null) return;
    const name=(n||'').trim(); if(!name||name===r.name) return;
    if(DOCS.enabled && r.httpSource){
      /* 改名 = 改这一段里的 ### 标题，仍然只动这一段 */
      const res=await DOCS.store.writeRequest(r.httpSource.file,{
        line:r.httpSource.line, method:r.method, title:name, name:name,
        interfaceId:r.httpSource.interfaceId||null
      },{ baseMtime:g.mtime });
      if(!res.ok){
        if(res.reason==='CONFLICT'){ await refreshDocs(true); setStatus('文件已被别处修改，已重新载入；确认后再改名','warn'); return; }
        setStatus('改名失败：'+(res.reason||''),'err'); return;
      }
      const ng=await patchGroup(g.path);
      if(ng&&ng.requests[res.segment]){
        const nr=ng.requests[res.segment];
        state.tabs.forEach(t=>{ if(t.savedId===r.id){ t.savedId=nr.id; t.name=name; setTabDocRef(t,g.path,nr,ng.mtime); } });
      }
      renderSidebar(); renderTabs();
      setStatus('已重命名为「'+name+'」','ok');
      return;
    }
    r.name=name;
    state.tabs.forEach(t=>{ if(t.savedId===r.id) t.name=name; });   // 同步已打开的 tab 标题
    persist(); renderSidebar(); renderTabs();
    setStatus('已重命名为「'+name+'」','ok');
  });
}
/* 拖拽移动：把请求 rid 移到分组 toGid；beforeRid 指定插入到哪个请求之前，null = 追加到末尾 */
function moveSaved(rid,toGid,beforeRid){
  if(!rid||beforeRid===rid) return;
  if(DOCS.enabled){ setStatus('文件真源下暂不支持拖拽移动（会丢注释，留到 1.0.1 做原文搬移）','warn'); return; }
  const src=findSaved(rid); if(!src) return;
  const dst=state.collections.find(g=>g.id===toGid); if(!dst) return;
  const idx=src.g.requests.findIndex(x=>x.id===rid);
  if(idx<0) return;
  const item=src.g.requests.splice(idx,1)[0];
  let at=dst.requests.length;
  if(beforeRid){ const bi=dst.requests.findIndex(x=>x.id===beforeRid); if(bi>=0) at=bi; }
  dst.requests.splice(at,0,item);
  dst.collapsed=false;
  persist(); renderSidebar();
  setStatus(src.g.id===dst.id?'已调整请求顺序':('已移动到「'+dst.name+'」'),'ok');
}
/* 同一分组内 r 的下一个请求 id（拖到底部时用），没有则 null */
function nextSavedId(g,rid){ const i=g.requests.findIndex(x=>x.id===rid); if(i<0) return null; const n=g.requests[i+1]; return n?n.id:null; }

function deleteGroup(g){
  if(DOCS.enabled && g.path){
    PD.confirm('删除文件「'+STORE.baseName(g.path)+'」及其中 '+g.requests.length+' 个请求？\n磁盘上的这个 .http 文件会被删掉，无法撤销。',async ok=>{
      if(!ok) return;
      const r=await DOCS.store.deleteCollection(g.path);
      if(!r.ok){ setStatus('删除失败：'+(r.reason||''),'err'); return; }
      /* 用户主动删的文件：顺手从映射里去掉，别在侧栏留一条灰色「找不到」。
       * 注意只有「主动删」才摘登记；文件被外部删掉时仍保留登记并标灰（S2.5b）。 */
      const M=window.POLARIS_MAP;
      if(M&&DOCS.map){
        try{
          const un=M.unregister(DOCS.map,M.toEntry(DOCS.dir,g.path));
          if(un.ok){ DOCS.map=un.map; await M.save(DOCS.store.host,DOCS.dir,DOCS.map); }
        }catch(e){}
      }
      state.tabs.forEach(t=>{ if(t.docRef&&t.docRef.file===g.path){ t.savedId=null; t.docRef=null; t.dirty=true; } });
      await refreshDocs(true); renderTabs();
      setStatus('已删除 '+STORE.baseName(g.path),'ok');
    });
    return;
  }
  PD.confirm('删除分组「'+g.name+'」及其中 '+g.requests.length+' 个请求？',ok=>{ if(!ok)return; const ids=g.requests.map(r=>r.id); state.collections=state.collections.filter(x=>x.id!==g.id); state.tabs.forEach(t=>{ if(ids.includes(t.savedId)){t.savedId=null;t.dirty=true;} }); persist(); renderSidebar(); renderTabs(); });
}

/* ===================== tab 操作 ===================== */
function closeTab(t){
  const doClose=()=>{ const i=state.tabs.indexOf(t); state.tabs.splice(i,1);
    if(!state.tabs.length){ const nt=newTab(); state.tabs.unshift(nt); state.activeTab=nt.id; }
    else if(state.activeTab===t.id) state.activeTab=state.tabs[Math.max(0,i-1)].id;
    renderAll(); persist(); };
  if(t.dirty&&(t.url||t.savedId)){ PD.confirm('该 tab 有未保存修改，仍要关闭？',ok=>{ if(ok) doClose(); }); return; }
  doClose();
}
/* ---- 右键菜单（tab 上右键调出） ---- */
function closeOthers(t){ state.tabs=state.tabs.filter(x=>x===t); state.activeTab=t.id; renderAll(); persist(); }
function closeRight(t){ const i=state.tabs.indexOf(t); state.tabs=state.tabs.slice(0,i+1); state.activeTab=t.id; renderAll(); persist(); }
function closeLeft(t){ const i=state.tabs.indexOf(t); state.tabs=state.tabs.slice(i); state.activeTab=t.id; renderAll(); persist(); }
let _ctxTab=null; // 右键菜单当前关联的 tab
let _ctxMenuClose=null; // 关闭函数
function showTabCtxMenu(e,t){
  e.preventDefault(); e.stopPropagation();
  _ctxTab=t;
  // 关闭旧菜单
  if(_ctxMenuClose) _ctxMenuClose();
  const menu=el('div','ctx-menu');
  menu.style.cssText='position:fixed;z-index:10001;background:var(--bg-2, #1e1f26);border:1px solid var(--line, #2a2b32);border-radius:8px;padding:4px 0;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,.4)';
  menu.style.left=Math.min(e.clientX,innerWidth-180)+'px';
  menu.style.top=Math.min(e.clientY,innerHeight-8)+'px';
  document.body.appendChild(menu);
  // 先挂载再读高度，确保 offsetHeight 正确
  menu.style.top=Math.min(e.clientY,innerHeight-menu.offsetHeight-8)+'px';
  const items=[
    {label:'✕ 关闭',action:()=>{closeTab(t);closeMenu();}},
    {label:'关闭其他',action:()=>{closeOthers(t);closeMenu();}},
    {label:'关闭右侧',action:()=>{closeRight(t);closeMenu();}},
    {label:'关闭左侧',action:()=>{closeLeft(t);closeMenu();}},
    {sep:true},
    {label:'✎ 重命名',action:()=>{closeMenu();PD.ask('重命名 tab',{value:t.name},n=>{if(n!=null){t.name=n.trim()||t.name;renderTabs();persist();}});}},
    {label:'📋 复制 URL',action:()=>{copy(t.url||'','URL 已复制');closeMenu();}},
    {label:'cURL 复制',action:()=>{copy(toCurl(t, resolveVars),'cURL 已复制');closeMenu();}},
  ];
  items.forEach(item=>{
    if(item.sep){ const hr=el('div'); hr.style.cssText='height:1px;background:var(--line,#2a2b32);margin:4px 0'; menu.appendChild(hr); return; }
    const b=el('button');
    b.textContent=item.label;
    b.style.cssText='display:block;width:100%;padding:6px 14px;text-align:left;font-size:12px;color:var(--ink,#d8dae2);background:none;border:none;cursor:pointer;white-space:nowrap';
    b.onmouseenter=()=>b.style.background='var(--surface,#262830)';
    b.onmouseleave=()=>b.style.background='none';
    b.onclick=item.action;
    menu.appendChild(b);
  });
  function closeMenu(){
    menu.remove(); _ctxMenuClose=null;
    document.removeEventListener('keydown',_onKey);
    document.removeEventListener('mousedown',_onDoc);
  }
  _ctxMenuClose=closeMenu;
  function _onKey(e2){ if(e2.key==='Escape') closeMenu(); }
  function _onDoc(e2){ if(!menu.contains(e2.target)) closeMenu(); }
  // 延迟绑定，避免当前右键事件立即触发关闭
  setTimeout(()=>{ document.addEventListener('keydown',_onKey); document.addEventListener('mousedown',_onDoc); }, 0);
}

/* ===================== 通用模态 ===================== */
function openModal(title,sub,fields,onOk){
  const bg=$('#modalBg'); const m=el('div','modal');
  m.innerHTML=`<h3>${esc(title)}</h3>${sub?`<div class="sub">${esc(sub)}</div>`:''}`;
  fields.forEach(f=>{ const fd=el('div','field'); fd.innerHTML=`<label>${esc(f.label)}</label>`+(f.type==='select'?`<select id="${f.id}">${f.html}</select>`:`<input id="${f.id}" type="text" value="${esc(f.value||'')}" />`); m.appendChild(fd); });
  const acts=el('div','acts'); const sp=el('div'); sp.style.flex='1';
  const cancel=el('button','btn ghost','取消'); cancel.onclick=close;
  const ok=el('button','btn primary','确定'); ok.onclick=()=>{ const vals={}; fields.forEach(f=>vals[f.id]=$('#'+f.id,m).value); if(onOk(vals)!==false) close(); };
  acts.append(sp,cancel,ok); m.appendChild(acts);
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open');
  const first=m.querySelector('input,select'); if(first){first.focus(); if(first.select)first.select();}
  m.addEventListener('keydown',e=>{ if(e.isComposing||e.keyCode===229) return; if(e.key==='Enter'&&e.target.tagName!=='SELECT')ok.click(); if(e.key==='Escape')close(); });
  bg.onclick=e=>{ if(e.target===bg)close(); };
  function close(){ bg.classList.remove('open'); bg.innerHTML=''; }
  return m;
}

/* ===================== 导入 / 导出集合（延迟到 initApi 绑定） ===================== */
function bindImportExport(){
  const eb=$('#exportBtn'); if(eb) eb.onclick=()=>{ const data=JSON.stringify({relay:2,exportedAt:new Date().toISOString(),collections:state.collections,envs:state.envs},null,2); const a=el('a'); a.href=URL.createObjectURL(new Blob([data],{type:'application/json'})); a.download='relay-export.json'; a.click(); setStatus('已导出集合与环境','ok'); };
  const ib=$('#importBtn'); if(ib) ib.onclick=()=>$('#fileInput').click();
  const fi=$('#fileInput'); if(fi) fi.onchange=e=>{ const f=e.target.files[0]; if(!f)return; const rd=new FileReader();
    rd.onload=async()=>{ try{ const d=JSON.parse(rd.result); const cols=Array.isArray(d)?d:d.collections; if(!Array.isArray(cols)) throw new Error('格式不符'); cols.forEach(g=>{ g.id=uid(); (g.requests||[]).forEach(r=>r.id=uid()); });
      /* 文件真源：导入 = 每个分组写成一个 .http 文件（同名不覆盖，旧数据留档 .warren-migrate/） */
      if(DOCS.enabled){
        const out=await STORE.migrateFromStorage(DOCS.store,cols,{});
        if(d.envs&&Array.isArray(d.envs)){ d.envs.forEach(en=>{en.id=uid();}); state.envs=state.envs.concat(d.envs); renderEnv(); persist(); }
        await refreshDocs(true);
        setStatus('已导入：新建 '+out.created.length+' 个 .http 文件'+(out.skipped.length?('，'+out.skipped.length+' 个同名已留档'):''),'ok');
        $('#fileInput').value=''; return;
      }
      state.collections=state.collections.concat(cols); if(d.envs&&Array.isArray(d.envs)){ d.envs.forEach(en=>{en.id=uid();}); state.envs=state.envs.concat(d.envs); renderEnv(); } persist(); renderSidebar(); setStatus('已导入 '+cols.length+' 个分组','ok'); }catch(err){ setStatus('导入失败：'+err.message,'err'); } $('#fileInput').value=''; };
    rd.readAsText(f);
  };
}

/* ===================== 响应工具按钮 ===================== */
function downloadResp(){ const t=activeTab(); const r=t.response; if(!r||r.error)return; const d=getDrilled(t); let name='response'; try{ const u=new URL(r.url); name=(u.pathname.split('/').pop()||'response'); }catch(e){} let blobUrl,revoke=false; if(r.isBinary&&r.blobUrl&&!t.respPath){ blobUrl=r.blobUrl; } else { const text=d.hasJSON?JSON.stringify(d.data,null,2):r.text; if(!/\./.test(name)) name+= d.hasJSON?'.json':/html/.test(r.contentType)?'.html':'.txt'; blobUrl=URL.createObjectURL(new Blob([text],{type:r.contentType||'text/plain'})); revoke=true; } const a=el('a'); a.href=blobUrl; a.download=name; a.click(); if(revoke)setTimeout(()=>URL.revokeObjectURL(blobUrl),1000); setStatus('已下载 '+name,'ok'); }

/* ===================== 事件绑定（延迟到 initApi 调用） ===================== */
function bindEvents(){
  const sb=$('#sendBtn'); if(sb) sb.onclick=send;
  const sv=$('#saveBtn'); if(sv) sv.onclick=saveCurrent;
  const srcb=$('#srcBtn'); if(srcb) srcb.onclick=()=>openSourceForTab();
  const cb=$('#curlBtn'); if(cb) cb.onclick=()=>copy(toCurl(activeTab(), resolveVars),'cURL 已复制');
  const ci=$('#curlImportBtn'); if(ci) ci.onclick=openCurlImport;
  const cr=$('#copyResBtn'); if(cr) cr.onclick=()=>{ const t=activeTab(); const d=getDrilled(t); if(!t.response||t.response.error)return; copy(d.hasJSON?JSON.stringify(d.data,null,2):(t.response.text||''),'已复制'); };
  const dl=$('#dlBtn'); if(dl) dl.onclick=downloadResp;
  const wr=$('#wrapBtn'); if(wr) wr.onclick=()=>{ const on=toggleRawWrap(); $('#wrapBtn').style.color=on?'var(--brand)':''; renderRespBody(); };
  const pt=$('#prettyBtn'); if(pt) pt.onclick=()=>{ const t=activeTab(); t.prettyCells=(t.prettyCells===false); persist(); renderRespBody(); };
  const te=$('#treeExpand'); if(te) te.onclick=()=>{ activeTab().treeOpen='all'; renderRespBody(); };
  const tc=$('#treeCollapse'); if(tc) tc.onclick=()=>{ activeTab().treeOpen='none'; renderRespBody(); };
  const url=$('#url');
  if(url){
    url.addEventListener('input',e=>{ const t=activeTab(); t.url=e.target.value; markDirty(t); updateResolvedPreview(); });
    url.addEventListener('change',e=>{ const t=activeTab(); t.url=e.target.value; syncUrlToParams(t); if(t.reqTab==='params')renderReqEditor(); persist(); });
    url.addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter') send(); });
  }
  $$('#reqSubtabs .subtab').forEach(b=>b.onclick=()=>{ activeTab().reqTab=b.dataset.rt; renderReqEditor(); persist(); });
  $$('#resSubtabs .subtab').forEach(b=>b.onclick=()=>{ if(b.classList.contains('disabled'))return; activeTab().respView=b.dataset.rv; renderRespBody(); persist(); });
  const srch=$('#search'); if(srch) srch.addEventListener('input',renderSidebar);
  const ng=$('#newGroup'); if(ng) ng.onclick=()=>{ PD.ask(DOCS.enabled?'新建 .http 文件（一个文件 = 一个 collection）':'新分组名称',{value:DOCS.enabled?'新集合':'新分组'},async n=>{
    if(!n) return;
    if(DOCS.enabled){
      const r=await DOCS.store.createCollection(n.trim());
      if(!r.ok){ setStatus('创建失败：'+(r.reason==='EXISTS'?'已有同名 .http 文件':(r.reason||'')),'err'); return; }
      await registerDocFile(r.path);
      await refreshDocs(true);
      setStatus('已创建 '+STORE.baseName(r.path),'ok');
      return;
    }
    state.collections.push({id:uid(),name:n.trim(),collapsed:false,requests:[]}); persist(); renderSidebar();
  }); };
  const rf=$('#refreshDocs'); if(rf) rf.onclick=async()=>{
    if(!DOCS.enabled){ setStatus('资源目录不可用（未连接宿主）','warn'); return; }
    const ok=await refreshDocs(false);
    if(ok) setStatus('已重新扫描 · '+DOCS.dir,'ok');
  };
  /* 从 IDEA / 记事本切回来时重扫，外部改动立即可见 */
  window.addEventListener('focus',()=>scheduleDocsRefresh(250));
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) scheduleDocsRefresh(250); });
  const ts=$('#toggleSide'); if(ts) ts.onclick=()=>{ ui.sideCollapsed=!ui.sideCollapsed; $('#main').classList.toggle('collapsed',ui.sideCollapsed); persist(); };
  const tb=$('#tabbar'); if(tb) tb.addEventListener('scroll',updateTabFade);
  const lb=$('#layoutBtn'); if(lb) lb.onclick=()=>{ ui.layout = ui.layout==='h'?'v':'h'; applyLayout(); persist(); };
  // DBX 单视图，无 currentView 路由判断；快捷键直接生效
  // .http 源码模式下 Ctrl+S 归编辑器（保存文件），这里必须让路，否则会同时弹「保存请求」弹窗
  document.addEventListener('keydown',e=>{
    const inEditor = window.POLARIS_EDITOR && window.POLARIS_EDITOR.isOpen && window.POLARIS_EDITOR.isOpen();
    const inEditorDom = e.target && e.target.closest && e.target.closest('#fileEditorPane');
    if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); if(!inEditor&&!inEditorDom) send(); return; }
    if((e.metaKey||e.ctrlKey)&&(e.key==='s'||e.key==='S')){
      if(inEditor||inEditorDom) return;          // 交给编辑器自己保存 .http
      e.preventDefault(); saveCurrent();
    }
  });
}
/* DBX 无代理按钮（顶栏未渲染 proxyBtn）；applyProxyBtn 保留为空操作以兼容 initApi 调用 */
function applyProxyBtn(){ /* no-op: DBX 沙箱无本地中继代理 */ }

/* 分隔条拖拽（适配上下/左右，窄面板友好） */
function bindDividerDrag(){
  const div=$('#divider'), split=$('#split'); if(!div||!split)return;
  let dragging=false;
  div.addEventListener('mousedown',e=>{ dragging=true; document.body.style.cursor=ui.layout==='h'?'col-resize':'row-resize'; document.body.style.userSelect='none'; e.preventDefault(); });
  document.addEventListener('mousemove',e=>{ if(!dragging)return; const r=split.getBoundingClientRect();
    if(ui.layout==='h'){ const w=Math.max(160,Math.min(Math.max(60,r.width-180),e.clientX-r.left)); ui.reqW=w; split.style.setProperty('--reqW',w+'px'); }
    else{ const h=Math.max(80,Math.min(Math.max(80,r.height-120),e.clientY-r.top)); ui.reqH=h; split.style.setProperty('--reqH',h+'px'); } });
  document.addEventListener('mouseup',()=>{ if(dragging){ dragging=false; document.body.style.cursor=''; document.body.style.userSelect=''; persist(); } });
}
/* 表格单元格悬停浮层：显示完整内容（截断或较长时） */
function bindCellTooltip(){
  const tip=$('#cellTip'); if(!tip)return;
  let on=false;
  const wantShow=td=>{ const full=td.getAttribute('data-full'); if(full==null||full==='') return null; const truncated=td.scrollWidth>td.clientWidth+1; return (truncated||full.length>56)?full:null; };
  document.addEventListener('mouseover',e=>{ const x=e.target; if(!(x instanceof Element))return; const td=x.closest('td[data-full]'); if(!td){ if(on){tip.classList.remove('show');on=false;} return; } const full=wantShow(td); if(full==null){ if(on){tip.classList.remove('show');on=false;} return; } tip.textContent=full.length>2000?full.slice(0,2000)+'…':full; tip.classList.add('show'); on=true; });
  document.addEventListener('mousemove',e=>{ if(!on)return; const pad=14,w=tip.offsetWidth,h=tip.offsetHeight; let x=e.clientX+pad,y=e.clientY+pad; if(x+w>innerWidth-8)x=e.clientX-w-pad; if(y+h>innerHeight-8)y=e.clientY-h-pad; tip.style.left=Math.max(8,x)+'px'; tip.style.top=Math.max(8,y)+'px'; });
  document.addEventListener('mouseout',e=>{ const x=e.target; if(!(x instanceof Element))return; if(x.closest('td[data-full]')){ tip.classList.remove('show'); on=false; } });
}
function applyLayout(){ const split=$('#split'); if(!split)return; split.classList.toggle('h',ui.layout==='h'); const defH=240, defW=520; split.style.setProperty('--reqH',(ui.reqH||defH)+'px'); split.style.setProperty('--reqW',(ui.reqW||defW)+'px'); const lb=$('#layoutBtn'); if(lb) lb.innerHTML = ui.layout==='h'?'⇅ 上下':'⇄ 左右'; }

/* ===================== 总渲染 + 初始化 ===================== */
function renderAll(){ renderTabs(); renderRequestBar(); renderReqEditor(); renderResponse(); renderSidebar(); renderEnv(); renderConflictBar(); }
async function initApi(){
  // 先绑定所有 DOM 事件（DOM 必须已就绪）
  bindMethodMenu();
  bindTopEvents();
  bindImportExport();
  bindEvents();
  bindDividerDrag();
  bindCellTooltip();
  // 配置 JSON 视图宿主钩子（持久化 + 重渲染反转注入）
  JV.configureViewHost({ persist, rerender: renderRespBody });
  // 等 DBX 桥就绪后加载状态并首渲染
  await DBX.ready;
  await load();
  /* 文件真源：把侧栏数据从 storage 切到资源目录（含一次性迁移）。失败则保持旧路径可用。 */
  await initDocs();
  const main=$('#main'); if(main) main.classList.toggle('collapsed',ui.sideCollapsed);
  applyLayout();
  applyProxyBtn();
  renderAll();
}

/* ===================== v0.3.0：供 http-workspace.js 使用的最小接口 =====================
 * 只暴露必要能力，避免新模块直接改动闭包内 state。 */
window.POLARIS_API = {
  uid: uid,
  blankRow: blankRow,
  newTab: newTab,
  resolveVars: resolveVars,
  addTab: function(seed){
    var t=newTab(seed); syncUrlToParams(t); t.dirty=true;
    state.tabs.unshift(t); state.activeTab=t.id; renderAll(); persist(); return t.id;
  },
  showResponse: function(resp){
    var t=activeTab(); if(!t) return;
    if(t.response && t.response.blobUrl) URL.revokeObjectURL(t.response.blobUrl);
    t.response=resp;
    t.respPath=''; t.respFilter=''; t.tableSel=null; t.colW={}; t.treeOpen='auto'; t.hiddenCols={}; t.sort={};
    t.respView = resp.parsed!==undefined ? (Array.isArray(resp.parsed)?'table':'object')
      : /text\/html/i.test(resp.contentType||'') ? 'preview'
      : (resp.isBinary && /^image\//i.test(resp.contentType||'')) ? 'preview' : 'raw';
    renderResponse();
    setStatus('已打开结果：'+resp.status+' '+(resp.statusText||''),'ok');
  },
  getActiveTab: activeTab,

  /* v0.3.2：文件编辑器执行一条 .http 请求，结果渲染进「原先的响应框」(#resPane)。
   * p: { method, url, headers:{k:v}, body, bodyType, timeoutMs }
   * 返回 response 对象（含 parsed）供编辑器做跨请求引用；失败返回 { error }。
   * 复用 app.js 内的 tryJSON / BINARY / b64ToBlob / respSize，避免与 send() 逻辑漂移。 */
  runRaw: async function(p){
    p=p||{};
    var method=String(p.method||'GET').toUpperCase();
    var url=String(p.url||'').trim();
    var headers=Object.assign({},p.headers||{});
    var body=p.body||'';
    var bodyBase64=p.bodyBase64||'';
    var bodyType=p.bodyType||'text';
    var tmo=p.timeoutMs||120000;
    var t0=performance.now();
    var sub=$('#resSubtabs'), sb=$('#resStatus'), tools=$('#resTools'), pane=$('#resPane');
    if(sub) sub.style.display='none';
    if(sb) sb.style.display='none';
    if(tools) tools.style.display='none';
    if(pane) pane.innerHTML='<div class="res-loading"><span class="spin"></span> '+esc(method)+' '+esc(url)+
      '<span style="color:var(--dimmer)"> · 请求发送中…</span></div>';
    setStatus(method+' '+url+' …');
    var resp;
    try{
      var r=await DBX.invoke('http/request',{method:method,url:url,headers:headers,body:body,bodyBase64:bodyBase64,bodyType:bodyType,timeoutMs:tmo});
      var ct=r.contentType||'';
      var isBin=BINARY.test(ct)||!!r.isBase64;
      var text=r.body||'';
      var blobUrl=null;
      if(isBin&&r.isBase64&&text){ var blob=b64ToBlob(text,ct); if(blob) blobUrl=URL.createObjectURL(blob); }
      var parsed=isBin?{ok:false}:tryJSON(text);
      resp={
        status:r.status, statusText:r.statusText||'', ok:!!r.ok,
        timeMs:r.timeMs||(performance.now()-t0),
        size:r.size||respSize(ct,text,r.isBase64)||0,
        contentType:ct, headers:r.headers||{}, text:text, isBinary:isBin, blobUrl:blobUrl,
        url:url, parsed:parsed.ok?parsed.value:undefined
      };
      window.POLARIS_API.showResponse(resp);
      setStatus(method+' '+resp.status+' '+resp.statusText+' · '+ms(resp.timeMs)+' · '+bytes(resp.size), resp.ok?'ok':'warn');
      /* 沿用原有「结果自动落盘」钩子（http-workspace.js） */
      if(window.POLARIS_HTTP_WS&&window.POLARIS_HTTP_WS.onResponse){
        try{ window.POLARIS_HTTP_WS.onResponse(activeTab(),resp,{method:method,url:url,headers:headers,body:body}); }catch(e){}
      }
    }catch(err){
      resp={ error:(err&&err.message)||String(err), timeMs:performance.now()-t0, url:url };
      window.POLARIS_API.showResponse(resp);
      setStatus('请求失败：'+resp.error,'err');
    }
    return resp;
  }
};

/* ===================== v0.9.0：文件真源给 .http 面板用的两个接口 =====================
 * 两处必须认同一个「资源目录」，否则 .http 面板扫 A 目录、侧栏扫 B 目录，用户会看到两套集合。 */
window.POLARIS_DOCS = {
  enabled: function(){ return DOCS.enabled; },
  dir: function(){ return DOCS.dir; },
  refresh: function(quiet){ return refreshDocs(quiet !== false); },
  /* S2.5：侧栏映射（wpa-workspace.json）。S2.5b 的文件夹树直接吃这个对象 */
  map: function(){ return DOCS.map; },
  mapError: function(){ return DOCS.mapError; },
  /* 新建/种出来的文件登记进侧栏（.http 面板种示例时用） */
  register: function(path){ return registerDocFile(path); },
  /* S2.3：源码视图点「▭」→ 在表单里打开这一段 */
  openInForm: function(path,info){ return openInFormForDoc(path,info); },
  /* S2.3：表单右上角「</>」→ 在源码里定位这一段 */
  openInSource: function(){ return openSourceForTab(); },
  setDir: async function(dir){
    dir=String(dir||'').trim();
    if(!DOCS.enabled||!dir||dir===DOCS.dir) return false;
    DOCS.dir=dir; DOCS.store.setDir(dir);
    /* 映射跟着资源目录走：换了目录就得读新目录里的 wpa-workspace.json */
    DOCS.map=null; DOCS.mapLoaded=false; DOCS.mapError=null;
    await loadWorkspaceMap();
    return refreshDocs(true);
  }
};

/* ===================== 启动 ===================== */
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded', initApi);
}else{
  initApi();
}
})();
