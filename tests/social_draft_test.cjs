'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const els = {};
function el(id) { return els[id] ||= {innerHTML:'', textContent:'', value:'', hidden:false, isConnected:true, disabled:false, addEventListener(t,f){this[t]=f;}, remove(){this.isConnected=false;}, querySelectorAll(){return []}}; }
let resolvePost;
const map = {on(){},addControl(){},getSource(){},fitBounds(){},resize(){}};
const context = { document:{getElementById:el,querySelectorAll:()=>[],body:{classList:{add(){},remove(){}}}}, window:{}, maplibregl:{Map:function(){return map;},NavigationControl:function(){}}, URLSearchParams, setTimeout(){}, fetch:async (url, opts={}) => {
  if (opts.method === 'POST') return new Promise(resolve => {resolvePost=()=>resolve({ok:true,json:async()=>({support_count:1,supported_by_me:true})});});
  return {ok:true,json:async()=>({user:null,categories:[],requests:[]})};
}};
vm.createContext(context); vm.runInContext(fs.readFileSync('frontend/app.js','utf8'),context);
(async()=>{
  await new Promise(setImmediate);
  vm.runInContext("state.me={id:2}; state.detail={request:{id:1,user_id:1,status:'in_progress'},assignments:[{id:1,user_id:2,status:'joined',changeset_ids:[]}],events:[],supported_by_me:false}; renderDetail()",context);
  el('report-comment').value='入力中の内容';
  const pending=el('act-support').click(); resolvePost(); await pending;
  assert.equal(el('report-comment').value,'入力中の内容'); assert.equal(el('support-count').textContent,1);
  assert.equal(el('act-support').textContent,'依頼へのいいねを取り消す');
  const late=el('act-support').click(); el('act-support').isConnected=false; el('support-count').textContent='別画面'; resolvePost(); await late;
  assert.equal(el('support-count').textContent,'別画面');
  console.log('いいね中の入力保持と画面遷移後の応答: OK');
})().catch(e=>{console.error(e); process.exitCode=1});
