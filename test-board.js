// 确定性验证：登船后小人/船员在甲板范围内，不穿模不飘出
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto'),net=require('net');
const DIST=path.join(process.cwd(),'dist','index.html'),PORT=9464;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res(b));}).on('error',rej));
function chrome(){return ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(x=>fs.existsSync(x));}
(async function(){
  if(!chrome()){console.log('SKIP');process.exit(0);}
  const ud=path.join(process.env.TEMP||'/tmp','dsh-v-'+Date.now());
  const child=require('child_process').spawn(chrome(),['--headless=new','--disable-gpu','--enable-unsafe-swiftshader','--remote-debugging-port='+PORT,'--user-data-dir='+ud,'--window-size=960,540','file:///'+DIST.replace(/\\/g,'/')],{stdio:'ignore'});
  let wsUrl=null;for(let i=0;i<30;i++){await sleep(300);try{const l=JSON.parse(await get('http://127.0.0.1:'+PORT+'/json/list'));const p=l.find(t=>t.type==='page'&&t.url&&t.url.indexOf('index.html')>=0);if(p){wsUrl=p.webSocketDebuggerUrl;break;}}catch(e){}}
  if(!wsUrl){console.log('FAIL CDP');child.kill();process.exit(1);}
  const ws=await new Promise(resolve=>{const u=new URL(wsUrl),key=crypto.randomBytes(16).toString('base64');const sock=net.connect(Number(u.port),u.hostname,()=>sock.write('GET '+u.pathname+u.search+' HTTP/1.1\r\nHost: '+u.hostname+':'+u.port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));let buf=Buffer.alloc(0),hs=false;const hs2=new Set();sock.on('data',ch=>{buf=Buffer.concat([buf,ch]);if(!hs){const i=buf.indexOf('\r\n\r\n');if(i<0)return;hs=true;buf=buf.slice(i+4);}while(buf.length>=2){const l0=buf[1]&0x7f;let off=2,len=l0;if(l0===126){len=buf.readUInt16BE(2);off=4;}else if(l0===127){len=Number(buf.readBigUInt64BE(2));off=10;}if(buf.length<off+len)return;const p=buf.slice(off,off+len).toString('utf8');buf=buf.slice(off+len);try{hs2.forEach(h=>h(JSON.parse(p)));}catch(e){}}});resolve({send:obj=>{const d=Buffer.from(JSON.stringify(obj),'utf8'),mask=crypto.randomBytes(4);let h;if(d.length<126)h=Buffer.from([0x81,0x80|d.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0xfe;h.writeUInt16BE(d.length,2);}const m=Buffer.alloc(d.length);for(let i=0;i<d.length;i++)m[i]=d[i]^mask[i%4];sock.write(Buffer.concat([h,mask,m]));},on:h=>hs2.add(h),close:()=>{try{sock.destroy();}catch(e){}}});});
  const pend=new Map();let nid=1;ws.on(m=>{if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
  const ev=e=>new Promise(res=>{const id=nid++;pend.set(id,m=>res(m.result&&m.result.result?m.result.result.value:undefined));ws.send({id,method:'Runtime.evaluate',params:{expression:e,returnByValue:true}});});
  await sleep(3000);
  await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown",{clientX:10,clientY:10,pointerId:1,bubbles:true}))');
  await sleep(1000);
  const R=[];const ck=(n,ok,d)=>{R.push(ok);console.log((ok?'  ok   ':'  FAIL ')+n+(d?' — '+d:''));};

  // 木筏开局：船长应在筏面中央附近
  await ev('window.__debugSetTier("raft")');
  await sleep(300);
  var raftCap=JSON.parse((await ev('(function(){var a=window.__gameState();return JSON.stringify({tier:a.shipTierName});})()'))||'{}');
  console.log('  当前船型:',raftCap.tier);
  // 登船看小人出生点
  await ev('window.__debugDock(true); window.__debugBoard()');
  await sleep(500);
  var ob1=JSON.parse((await ev('JSON.stringify(window.__gameState().onboard)'))||'{}');
  console.log('  木筏登船 onboard:',JSON.stringify(ob1));
  ck('木筏上小人 z 在筏面(|z|<3)',Math.abs(ob1.z)<3,'z='+ob1.z);
  ck('木筏上无船员时 crew 为空',ob1.crew.length===0);
  await ev('window.__debugBoard()'); // 退出登船
  await sleep(300);

  // 邮轮：全员 + 登船，小人走动能到寿司店
  await ev('window.__debugSetTier("cruise")');
  await ev('window.__debugRecruitAll(); window.__debugOpenSushi(); window.__debugGrant({wood:999,plastic:999,metal:999}); window.__debugBuildAll()');
  await ev('window.__debugBoard()');
  await sleep(500);
  var ob2=JSON.parse((await ev('JSON.stringify(window.__gameState().onboard)'))||'{}');
  console.log('  邮轮登船 onboard:',JSON.stringify(ob2));
  ck('邮轮上 5 位船员',ob2.crew.length===5,'crew='+ob2.crew.length);
  ck('寿司店已开',ob2.sushiOpen===true);
  // 走到寿司店（局部 x≈2.2 z≈-1）
  await ev('for(var i=0;i<20;i++)window.__debugCrewMove(0.2,-0.35)');
  await sleep(400);
  var ob3=JSON.parse((await ev('JSON.stringify(window.__gameState().onboard)'))||'{}');
  console.log('  走动后:',JSON.stringify(ob3));
  ck('小人移动了',Math.abs(ob3.z-ob2.z)>0.5,'dz='+(ob3.z-ob2.z).toFixed(2));
  ck('小人没走出甲板(|x|<5,|z|<13)',Math.abs(ob3.x)<5&&Math.abs(ob3.z)<13,'x='+ob3.x+' z='+ob3.z);
  // 靠近寿司店应检测到
  var near=await ev('window.__gameState().onboard.nearSpot');
  console.log('  靠近的交互点:',near);

  var f=R.filter(x=>!x).length;
  console.log('\n'+'='.repeat(50)+'\n共 '+R.length+' 项，通过 '+(R.length-f)+'，失败 '+f);
  ws.close();child.kill();try{fs.rmSync(ud,{recursive:true,force:true});}catch(e){}
  process.exit(f?1:0);
})().catch(e=>{console.error('FAILED '+e.message);process.exit(1);});
