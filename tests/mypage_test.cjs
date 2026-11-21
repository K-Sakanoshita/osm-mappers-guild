'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const elements = {};
function el(id) { return elements[id] ||= { hidden:false, value:'', innerHTML:'', textContent:'', focus() {}, removeAttribute(name) { delete this[name]; }, addEventListener(t, f) { this[t] = f; }, querySelector() { return null; } }; }
const map = { on() {}, addControl() {}, getSource() {}, fitBounds() {}, resize() {} };
const calls = [];
let deferred = null;
const response = (data) => ({ok:true, json: async () => data});
const context = { document: { addEventListener() {}, getElementById:el, querySelectorAll:()=>[], body:{classList:{add(){},remove(){}}}}, window:{}, maplibregl:{Map:function(){return map;},NavigationControl:function(){}}, URLSearchParams, setTimeout(){}, fetch: async (url, options={}) => {
  calls.push(url);
  if (url.endsWith('/me')) return response({user:{id:1,osm_user_id:10,display_name:'<利用者>'},csrf_token:'token',categories:[]});
  if (url.endsWith('/user/10.json')) {
    assert.equal(options.credentials, 'omit');
    return response({user:{img:{href:'https://example.org/avatar.png'}}});
  }
  if (url.includes('owner=me')) {
    assert(!url.includes('bbox='));
    if (url.includes('cursor=older')) return response({requests:[{id:3,title:'以前の自分の依頼',status:'completed',category:'建物'}],next_cursor:null});
    return deferred ? new Promise(resolve => { deferred.resolve = () => resolve(response({requests:[{id:1,title:'古い一覧',status:'open',category:'建物'}]})); }) : response({requests:[{id:1,title:'<自分の依頼>',status:'open',category:'建物'}],next_cursor:'older'});
  }
  if (url.includes('participating=me')) return response({requests:[{id:2,title:'参加した依頼',status:'in_progress',category:'道路'}]});
  if (url.endsWith('/auth/logout')) return response({ok:true});
  return response({requests:[]});
}};
vm.createContext(context); vm.runInContext(fs.readFileSync('frontend/app.js','utf8'),context);
(async()=>{
  await new Promise(setImmediate);
  assert.equal(el('btn-login').hidden,true); assert.equal(el('account-menu').hidden,false);
  assert.equal(el('account-name').textContent, '<利用者>');
  assert.equal(el('account-image').src, 'https://example.org/avatar.png');
  el('account-image').load();
  assert.equal(el('account-image').hidden, false);
  el('account-image').error();
  assert.equal(el('account-image').hidden, true);
  el('account-menu').open = true;
  await el('btn-mypage').click();
  assert.equal(el('account-menu').open, false);
  assert(calls.some(x=>x.includes('owner=me')) && calls.some(x=>x.includes('participating=me')));
  assert.match(el('panel-content').innerHTML,/&lt;利用者&gt;/);
  assert.match(el('mypage-owned').innerHTML,/&lt;自分の依頼&gt;/);
  assert.match(el('mypage-joined').innerHTML,/参加した依頼/);
  assert.match(el('mypage-owned').innerHTML,/さらに読み込む/);
  el('mypage-owned').click({target:{closest:selector=>selector === '.mypage-more'}});
  await new Promise(setImmediate);
  assert.match(el('mypage-owned').innerHTML,/&lt;自分の依頼&gt;[\s\S]*以前の自分の依頼/);
  assert.doesNotMatch(el('mypage-owned').innerHTML,/さらに読み込む/);
  assert.match(el('panel-content').innerHTML,/id="btn-new-request"/);
  el('btn-new-request').click();
  assert.match(el('panel-content').innerHTML,/id="request-form"/);
  deferred={}; const pending=el('btn-mypage').click(); await new Promise(setImmediate);
  vm.runInContext("openPanel('<h2>別画面</h2>')",context);
  el('mypage-owned').innerHTML='保持'; deferred.resolve(); await pending;
  assert.equal(el('mypage-owned').innerHTML,'保持'); assert.match(el('panel-content').innerHTML,/別画面/);
  deferred=null; await el('btn-mypage').click(); await el('btn-logout').click();
  assert.equal(el('btn-login').hidden,false); assert.equal(el('account-menu').hidden,true); assert.equal(el('panel').hidden,true);
  assert.equal(el('account-image').src, undefined);
  console.log('マイページの一覧取得、画面遷移、ログアウト: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
