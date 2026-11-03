import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const endpoint = 'https://www.xingtu.cn/gw/api/orders/get_link_list';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,48);

export function transition(previous, account, rows, error=null) {
  const state = structuredClone(previous);
  const saved = state.accounts[account] ??= {items:{}, missing:{}, error:null};
  const events=[];
  if(error) {
    if(saved.error!==error) events.push({account,kind:'读取或登录故障',detail:error});
    saved.error=error;
    return {state,events};
  }
  if(!Array.isArray(rows)||!rows.length) throw new Error('Empty snapshot');
  if(new Set(rows.map(x=>x.id)).size!==rows.length) throw new Error('Duplicate IDs');
  if(rows.some(x=>typeof x.id!=='string'||!x.name||!x.status)) throw new Error('Invalid rows');
  if(saved.error) events.push({account,kind:'读取恢复'});
  saved.error=null;
  const current=Object.fromEntries(rows.map(row=>[row.id,row]));
  for(const row of rows) {
    const old=saved.items[row.id];
    if(!old&&row.status!=='有效') events.push({account,kind:'首次发现异常',...row});
    if(old&&old.status!==row.status) events.push({account,kind:'组件状态变化',before:old.status,...row});
    if((saved.missing[row.id]??0)>=2) events.push({account,kind:'组件重新出现',...row});
    delete saved.missing[row.id]; saved.items[row.id]=row;
  }
  for(const [id,row] of Object.entries(saved.items)) {
    if(!current[id]) {
      saved.missing[id]=(saved.missing[id]??0)+1;
      if(saved.missing[id]===2) events.push({account,kind:'两次完整查询均未找到组件',...row});
    }
  }
  return {state,events};
}

export async function readAccount(config, fetcher=fetch) {
  const original=new URL(config.url);
  if(original.origin!=='https://www.xingtu.cn'||original.pathname!=='/gw/api/orders/get_link_list') throw new Error('Unexpected API destination');
  if(!config.expected_ids?.length||!Object.entries(config.headers??{}).some(([k,v])=>k.toLowerCase()==='cookie'&&v)) throw new Error('Missing authentication or baseline');
  if([...original.searchParams.keys()].some(k=>!['page','limit','link_platform_source'].includes(k))) throw new Error('Unexpected list filter');
  if(original.searchParams.get('link_platform_source')!=='1') throw new Error('Unexpected platform');
  let total=null; const rows=new Map(); let complete=false;
  for(let page=1;page<=100;page++) {
    const url=new URL(endpoint);url.searchParams.set('page',String(page));url.searchParams.set('limit','10');url.searchParams.set('link_platform_source','1');
    const response=await fetcher(url,{headers:config.headers,redirect:'error',signal:AbortSignal.timeout(25000)});
    if(!response.ok) throw new Error('HTTP failure');
    const data=await response.json();
    if(data.base_resp?.status_code!==0) throw new Error('Authentication or API failure');
    const paging=data.pagination;
    if(!paging||paging.page!==page||!Number.isSafeInteger(paging.total_count)||paging.total_count<=0) throw new Error('Invalid pagination');
    total??=paging.total_count;
    if(total!==paging.total_count||!Array.isArray(data.links)||!data.links.length) throw new Error('Incomplete or changing list');
    for(const link of data.links) {
      if(typeof link.id!=='string'||!/^\d{18,20}$/.test(link.id)||!link.link_name||!Number.isInteger(link.status)||!Number.isInteger(link.audit_status)||rows.has(link.id)) throw new Error('Invalid component row');
      rows.set(link.id,{id:link.id,name:link.link_name,status:link.status===1&&link.audit_status===0?'有效':`状态代码 ${link.status} / 审核代码 ${link.audit_status}`,reason:String(link.audit_ban_reason||link.ban_reason||'')});
    }
    if(paging.has_more===false) {complete=true;break;}
    if(paging.has_more!==true) throw new Error('Missing continuation flag');
  }
  if(!complete||rows.size!==total) throw new Error('Incomplete list');
  if(!config.expected_ids.some(id=>rows.has(id))) throw new Error('Account/list continuity needs verification');
  return [...rows.values()].sort((a,b)=>a.id.localeCompare(b.id));
}

function key() {const value=Buffer.from(process.env.STATE_KEY??'','base64');if(value.length!==32)throw new Error('Invalid state key');return value;}
export function seal(value, secret) {
  const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',secret,iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function unseal(value, secret) {
  const raw=Buffer.from(value,'base64');const cipher=createDecipheriv('aes-256-gcm',secret,raw.subarray(0,12));
  cipher.setAuthTag(raw.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString('utf8'));
}

async function cli(args, input, json=true) {
  // execFile, no shell; capture CLI output so credentials cannot appear in CI logs.
  const child=exec(process.env.LARK_CLI??'lark-cli',args,{timeout:60000,maxBuffer:1024*1024});
  if(input!==undefined) {child.child.stdin.end(input);}
  const {stdout}=await child;
  return json ? JSON.parse(stdout) : stdout;
}

async function configureBot() {
  if(!/^oc_/.test(process.env.NOTIFICATION_CHAT_ID??''))throw new Error('Missing notification destination');
  if(process.env.LARK_USE_EXISTING_PROFILE==='1')return;
  if(!process.env.LARK_APP_ID||!process.env.LARK_APP_SECRET||!/^oc_/.test(process.env.NOTIFICATION_CHAT_ID??'')) throw new Error('Missing bot credentials or destination');
  await cli(['config','init','--app-id',process.env.LARK_APP_ID,'--app-secret-stdin','--brand','feishu'],process.env.LARK_APP_SECRET,false);
}

async function notify(event, revision) {
  const text='【星图组件监测·TO DO测试】\n'+Object.entries(event).map(([k,v])=>`${k}：${v}`).join('\n')+'\n'+new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）';
  const result=await cli(['im','+messages-send','--chat-id',process.env.NOTIFICATION_CHAT_ID,'--as','bot','--text','-','--idempotency-key',digest([revision,event])],text);
  if(result.ok!==true||!result.data?.message_id)throw new Error('No notification receipt');
  return result.data.message_id;
}

export async function main(mode=process.argv[2]??'check') {
  const file=process.env.STATE_FILE??'.state/state.enc'; const secret=key();
  let state;
  try {state=unseal(await readFile(file,'utf8'),secret);} catch(error) {if(error.code!=='ENOENT')throw new Error('State cannot be decrypted');state={accounts:{},revision:0,lastRun:null,watchdogAlarm:false};}
  await configureBot();
  const now=Date.now();const events=[];let bad=0;let count=0;
  if(mode==='watchdog') {
    if(!state.lastRun||now-state.lastRun>30*60*1000) {
      if(!state.watchdogAlarm) {events.push({kind:'云端监测中断',detail:'超过30分钟没有运行回执，请检查定时任务。'});state.watchdogAlarm=true;}
    }
  } else {
    const configs=JSON.parse(process.env.WATCH_CONFIG_JSON??'null');
    if(!Array.isArray(configs)||configs.length!==2||new Set(configs.map(x=>x.id)).size!==2)throw new Error('Two distinct authenticated accounts required');
    for(const config of configs) {
      try {
        const rows=await readAccount(config);const change=transition(state,config.id,rows);
        if(change.events.length) {
          const confirmation=await readAccount(config);
          if(JSON.stringify(rows)!==JSON.stringify(confirmation))throw new Error('Observations disagree');
        }
        state=change.state;events.push(...change.events);count+=rows.length;
      } catch {
        bad++;const change=transition(state,config.id,null,'接口不可用、登录失效或完整性校验失败，请人工检查。');state=change.state;events.push(...change.events);
      }
    }
    if(state.watchdogAlarm) {events.push({kind:'云端调度恢复'});state.watchdogAlarm=false;}
    state.lastRun=now;state.failedAccounts=bad;
    if(mode==='validate'&&bad===0)events.push({kind:'云端真实读取验证成功',accounts:2,components:count,detail:'已在云端读取真实组件；本条是TO DO测试回执，不是异常告警。'});
  }
  for(const event of events)await notify(event,state.revision);
  state.revision+=events.length?1:0;
  // Only acknowledged transitions are written. Public storage contains ciphertext only.
  await writeFile(file,seal(state,secret),{mode:0o600});
  console.log(JSON.stringify({mode,accounts:mode==='watchdog'?undefined:2,components:count,failedAccounts:bad,notifications:events.length,checkedAt:new Date(now).toISOString()}));
  if(bad)process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{console.error('Monitoring cycle failed; inspect authentication, bot access, or state configuration. No credentials were logged.');process.exitCode=1;});
}
