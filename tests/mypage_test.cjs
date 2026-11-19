'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const elements = {};
function el(id) { return elements[id] ||= { hidden:false, value:'', innerHTML:'', textContent:'', addEventListener(t, f) { this[t] = f; }, querySelectorAll() { return []; } }; }
const map = { on() {}, addControl() {}, getSource() {}, fitBounds() {}, resize() {} };
const calls = [];
let deferred = null;
const response = (data) => ({ok:true, json: async () => data});
const context = { document: {getElementById:el, querySelectorAll:()=>[], body:{classList:{add(){},remove(){}}}}, window:{}, maplibregl:{Map:function(){return map;},NavigationControl:function(){}}, URLSearchParams, setTimeout(){}, fetch: async (url, options={}) => {
  calls.push(url);
  if (url.endsWith('/me')) return response({user:{id:1,osm_user_id:10,display_name:'<利用者>'},csrf_token:'token',categories:[]});
  if (url.includes('owner=me')) return deferred ? new Promise(resolve => { deferred.resolve = () => resolve(response({requests:[{id:1,title:'古い一覧',status:'open',category:'建物'}]})); }) : response({requests:[{id:1,title:'<自分の依頼>',status:'open',category:'建物'}]});
  if (url.includes('participating=me')) return response({requests:[{id:2,title:'参加した依頼',status:'in_progress',category:'道路'}]});
  if (url.endsWith('/auth/logout')) return response({ok:true});
  return response({requests:[]});
}};
vm.createContext(context); vm.runInContext(fs.readFileSync('frontend/app.js','utf8'),context);
(async()=>{
  await new Promise(setImmediate);
  assert.equal(el('btn-login').hidden,true); assert.equal(el('btn-mypage').hidden,false);
  await el('btn-mypage').click();
  assert(calls.some(x=>x.includes('owner=me')) && calls.some(x=>x.includes('participating=me')));
  assert.match(el('panel-content').innerHTML,/&lt;利用者&gt;/);
  assert.match(el('mypage-owned').innerHTML,/&lt;自分の依頼&gt;/);
  assert.match(el('mypage-joined').innerHTML,/参加した依頼/);
  assert.match(el('panel-content').innerHTML,/id="btn-new-request"/);
  el('btn-new-request').click();
  assert.match(el('panel-content').innerHTML,/id="request-form"/);
  deferred={}; const pending=el('btn-mypage').click(); await new Promise(setImmediate);
  vm.runInContext("openPanel('<h2>別画面</h2>')",context);
  el('mypage-owned').innerHTML='保持'; deferred.resolve(); await pending;
  assert.equal(el('mypage-owned').innerHTML,'保持'); assert.match(el('panel-content').innerHTML,/別画面/);
  deferred=null; await el('btn-mypage').click(); await el('btn-logout').click();
  assert.equal(el('btn-login').hidden,false); assert.equal(el('btn-mypage').hidden,true); assert.equal(el('panel').hidden,true);
  console.log('マイページの一覧取得、画面遷移、ログアウト: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
