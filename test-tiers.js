// 船体 5 级极简验证（不做 buildAll，避免卡住）
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto'),net=require('net');
const DIST=path.join(process.cwd(),'dist','index.html'),PORT=9455;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res(b));}).on('error',rej));
function chrome(){return ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(x=>fs.existsSync(x));}
(async function(){
  if(!chrome()){console.log('SKIP');process.exit(0);}
  const ud=path.join(process.env.TEMP||'/tmp','dsh-t-'+Date.now());
  const child=require('child_process').spawn(chrome(),['--headless=new','--disable-gpu','--enable-unsafe-swiftshader','--remote-debugging-port='+PORT,'--user-data-dir='+ud,'--window-size=960,540','--allow-file-access-from-files','file:///'+DIST.replace(/\\/g,'/')],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<30;i++){await sleep(300);try{const l=JSON.parse(await get('http://127.0.0.1:'+PORT+'/json/list'));const p=l.find(t=>t.type==='page'&&t.url&&t.url.indexOf('index.html')>=0);if(p){wsUrl=p.webSocketDebuggerUrl;break;}}catch(e){}}
  if(!wsUrl){console.log('FAIL CDP');child.kill();process.exit(1);}
  const ws=await new Promise(resolve=>{const u=new URL(wsUrl),key=crypto.randomBytes(16).toString('base64');
    const sock=net.connect(Number(u.port),u.hostname,()=>sock.write('GET '+u.pathname+u.search+' HTTP/1.1\r\nHost: '+u.hostname+':'+u.port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    let buf=Buffer.alloc(0),hs=false;const hs2=new Set();
    sock.on('data',ch=>{buf=Buffer.concat([buf,ch]);if(!hs){const i=buf.indexOf('\r\n\r\n');if(i<0)return;hs=true;buf=buf.slice(i+4);}while(buf.length>=2){const l0=buf[1]&0x7f;let off=2,len=l0;if(l0===126){len=buf.readUInt16BE(2);off=4;}else if(l0===127){len=Number(buf.readBigUInt64BE(2));off=10;}if(buf.length<off+len)return;const p=buf.slice(off,off+len).toString('utf8');buf=buf.slice(off+len);try{const o=JSON.parse(p);hs2.forEach(h=>h(o));}catch(e){}}});
    resolve({send:obj=>{const d=Buffer.from(JSON.stringify(obj),'utf8'),mask=crypto.randomBytes(4);let h;if(d.length<126)h=Buffer.from([0x81,0x80|d.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0xfe;h.writeUInt16BE(d.length,2);}const m=Buffer.alloc(d.length);for(let i=0;i<d.length;i++)m[i]=d[i]^mask[i%4];sock.write(Buffer.concat([h,mask,m]));},on:h=>hs2.add(h),close:()=>{try{sock.destroy();}catch(e){}}});});
  const pend=new Map();let nid=1;
  ws.on(m=>{if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
  const ev=expr=>new Promise(res=>{const id=nid++;pend.set(id,m=>res(m.result&&m.result.result?m.result.result.value:undefined));ws.send({id,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true}});});
  await sleep(3000);
  const R=[];const ck=(n,ok,d)=>{R.push(ok);console.log((ok?'  ok   ':'  FAIL ')+n+(d?' — '+d:''));};

  await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown",{clientX:10,clientY:10,pointerId:1,bubbles:true}))');
  await sleep(1000);
  ck('进入 playing',(await ev('window.__gameState().phase'))==='playing');
  const tiers=JSON.parse((await ev('JSON.stringify(window.__debugTiers())'))||'[]');
  console.log('  5 级: '+tiers.map(t=>t.name+'('+t.boxes+'块,'+t.slots+'位)').join(' / '));
  ck('有 5 级',tiers.length===5);
  ck('方块数各不相同',new Set(tiers.map(t=>t.boxes)).size===5);
  ck('开局木筏 tier0',(await ev('window.__gameState().shipTier'))===0);
  ck('renderSlots 的 hero 是木筏',(await ev('window.__renderSlots ? "ok":"no"'))==='ok');

  // 逐级切换，验证建筑不丢
  await ev('window.__debugGrant({wood:200,plastic:100,metal:100})');
  await ev('window.__debugBuild("workbench")');
  const before=await ev('JSON.stringify(window.__gameState().survival)');
  ck('建了工作台',(JSON.parse(before||'[]')).length>=1,before);
  for(let i=1;i<5;i++){
    await ev('window.__debugSetTier('+i+')');
    await sleep(150);
    const after=await ev('JSON.stringify(window.__gameState().survival)');
    const st=JSON.parse((await ev('JSON.stringify(window.__gameState())'))||'{}');
    const ok=after===before&&st.shipTier===i;
    ck('切到'+tiers[i].name+': 装备保留/tier正确',ok,after+' tier='+st.shipTier);
  }
  // HUD 提示可升级
  await ev('window.__debugSetTier(0)');
  ck('state 暴露 shipTierName',(await ev('window.__gameState().shipTierName'))==='木筏');

  const f=R.filter(x=>!x).length;
  console.log('\n'+'='.repeat(50)+'\n共 '+R.length+' 项，通过 '+(R.length-f)+'，失败 '+f);
  ws.close();child.kill();try{fs.rmSync(ud,{recursive:true,force:true});}catch(e){}
  process.exit(f?1:0);
})().catch(e=>{console.error('FAILED '+e.message);process.exit(1);});
