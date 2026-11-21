'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const elements = {};
function el(id) { return elements[id] ||= { innerHTML: '', textContent: '', value: '', hidden: false, removeAttribute() {}, addEventListener() {}, querySelectorAll() { return []; } }; }
const map = { on() {}, addControl() {}, getSource() {}, resize() {}, fitBounds() {} };
const context = { document: { addEventListener() {}, getElementById: el, querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } } }, window: {}, maplibregl: { Map: function () { return map; }, NavigationControl: function () {} }, URLSearchParams, setTimeout() {}, fetch: async () => ({ok:true,json:async()=>({user:null,categories:[]})}) };
vm.createContext(context);
vm.runInContext(fs.readFileSync('frontend/app.js','utf8'), context);
setImmediate(() => {
  vm.runInContext(`state.me = {id: 2}; state.detail = {request:{id:1,user_id:1,status:'withdrawn'}, assignments:[{id:3,user_id:1,status:'approved',changeset_ids:[],like_count:1,liked_by_me:true}], events:[], supported_by_me:true}; renderDetail()`, context);
  assert.match(el('detail-actions').innerHTML, /依頼へのいいねを取り消す/);
  assert.match(el('panel-content').innerHTML, /いいねを取り消す/);
  vm.runInContext('state.detail.supported_by_me=false; state.detail.assignments[0].liked_by_me=false; renderDetail()', context);
  assert.doesNotMatch(el('detail-actions').innerHTML, /act-support/);
  assert.doesNotMatch(el('panel-content').innerHTML, /data-like-toggle/);
  vm.runInContext("state.detail.request.status='open'; state.detail.assignments=[]; renderDetail()", context);
  assert.match(el('detail-actions').innerHTML, /依頼にいいね/);
  assert.match(el('panel-content').innerHTML, /依頼へのいいね/);
  console.log('取り下げ後のいいね操作: OK');
});
