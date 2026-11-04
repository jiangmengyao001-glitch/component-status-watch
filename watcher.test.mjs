import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {transition,readAccount,seal,unseal,formatEvent,shouldNotify} from './watcher.mjs';
const row=(status='有效')=>({id:'1234567890123456789',name:'Synthetic component',status});
test('status change, no repeated alert and recovery',()=>{
  let {state}=transition({accounts:{}},'synthetic',[row()]);
  let result=transition(state,'synthetic',[row('Synthetic abnormal')]);assert.equal(result.events.length,1);
  result=transition(result.state,'synthetic',[row('Synthetic abnormal')]);assert.equal(result.events.length,0);
  assert.equal(transition(result.state,'synthetic',[row()]).events[0].status,'有效');
});
test('errors are isolated from missing components',()=>{
  const {state}=transition({accounts:{}},'synthetic',[row()]);
  const result=transition(state,'synthetic',null,'Synthetic login error');
  assert.equal(result.events.length,1);assert.deepEqual(result.state.accounts.synthetic.missing,{});
  assert.equal(transition(result.state,'synthetic',null,'Synthetic login error').events.length,0);
});
test('missing requires two complete snapshots',()=>{
  const other={...row(),id:'2234567890123456789'};
  let {state}=transition({accounts:{}},'synthetic',[row(),other]);
  let result=transition(state,'synthetic',[other]);assert.equal(result.events.length,0);
  result=transition(result.state,'synthetic',[other]);assert.equal(result.events.length,1);
  assert.equal(transition(result.state,'synthetic',[other]).events.length,0);
});
test('state is authenticated ciphertext',()=>{
  const key=randomBytes(32);const state={secret:'synthetic data'};const blob=seal(state,key);
  assert.ok(!blob.includes(state.secret));assert.deepEqual(unseal(blob,key),state);
  assert.throws(()=>unseal(blob,randomBytes(32)));
});
test('pagination is complete and filtered lists fail closed',async()=>{
  const config={url:'https://www.xingtu.cn/gw/api/orders/get_link_list?page=1&limit=10&link_platform_source=1',headers:{cookie:'synthetic'},expected_ids:[row().id]};
  let calls=0;
  const fetcher=async url=>{calls++;const page=Number(url.searchParams.get('page'));return {ok:true,json:async()=>({base_resp:{status_code:0},links:[{id:page===1?row().id:'2234567890123456789',link_name:'Synthetic',status:1,audit_status:0}],pagination:{page,total_count:2,has_more:page===1}})}};
  assert.equal((await readAccount(config,fetcher)).length,2);assert.equal(calls,2);
  await assert.rejects(()=>readAccount({...config,url:config.url+'&status=1'},fetcher));
  await assert.rejects(()=>readAccount(config,async()=>({ok:true,json:async()=>({base_resp:{status_code:1}})})));
});

test('abnormal notification uses requested account and component fields',()=>{
  assert.equal(formatEvent({kind:'组件状态变化',account:'synthetic-account',id:'synthetic-id',status:'异常'}),'老师，这个星图账户下落地页组件卡审，辛苦捞回：\n星图账户ID：synthetic-account\n组件ID：synthetic-id');
  assert.ok(!formatEvent({kind:'组件状态变化',account:'synthetic-account',id:'synthetic-id',status:'有效'}).includes('辛苦捞回'));
});

test('abnormal alerts include a real mention, recovery stays quiet for mentions',()=>{
 const event={kind:'组件状态变化',account:'synthetic-account',id:'synthetic-id',status:'异常'};
 assert.ok(formatEvent(event,'ou_synthetic').startsWith('<at user_id="ou_synthetic"></at>\n老师'));
 assert.ok(!formatEvent({...event,status:'有效'},'ou_synthetic').includes('<at'));
 assert.ok(formatEvent({...event,kind:'两次完整查询均未找到组件',status:'有效'},'ou_synthetic').includes('<at'));
});

test('business group receives component anomalies only',()=>{
 for(const kind of ['读取或登录故障','读取恢复','云端监测中断','云端调度恢复','云端真实读取验证成功'])assert.equal(shouldNotify({kind}),false);
 assert.equal(shouldNotify({kind:'组件状态变化',id:'synthetic',status:'有效'}),false);
 assert.equal(shouldNotify({kind:'组件状态变化',id:'synthetic',status:'异常'}),true);
 assert.equal(shouldNotify({kind:'两次完整查询均未找到组件',id:'synthetic',status:'有效'}),true);
});
