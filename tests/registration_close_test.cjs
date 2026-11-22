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
  const reqOpen = `request:{id:1,user_id:1,status:'open',registration_closed:false,participant_count:0,reported_count:0,approved_count:0,working_count:0,changes_requested_count:0,all_approved:false}`;
  // 依頼者・open・未締め切り: 締め切りボタンと参加ボタンが出る
  vm.runInContext(`state.me = {id: 1}; state.detail = {${reqOpen}, assignments:[], events:[], supported_by_me:false}; renderDetail()`, context);
  assert.match(el('detail-actions').innerHTML, /act-close-reg/);
  assert.match(el('detail-actions').innerHTML, /act-join/);
  assert.doesNotMatch(el('panel-content').innerHTML, /参加受付は締め切られています/);
  // 依頼者以外: 締め切りボタンは出ない
  vm.runInContext(`state.me = {id: 2}; state.detail = {${reqOpen}, assignments:[], events:[], supported_by_me:false}; renderDetail()`, context);
  assert.doesNotMatch(el('detail-actions').innerHTML, /act-close-reg/);
  assert.match(el('detail-actions').innerHTML, /act-join/);
  // 締め切り済み・依頼者: 締め切りボタンも参加ボタンも出ない、締め切り表示が出る
  vm.runInContext(`state.me = {id: 1}; state.detail = {request:{id:1,user_id:1,status:'open',registration_closed:true,participant_count:1,reported_count:0,approved_count:0,working_count:0,changes_requested_count:0,all_approved:false}, assignments:[{id:3,user_id:2,status:'joined',changeset_ids:[],like_count:0,liked_by_me:false}], events:[], supported_by_me:false}; renderDetail()`, context);
  assert.doesNotMatch(el('detail-actions').innerHTML, /act-close-reg/);
  assert.doesNotMatch(el('detail-actions').innerHTML, /act-join/);
  assert.match(el('panel-content').innerHTML, /参加受付は締め切られています/);
  // 締め切り済みでも既存参加者の操作（参加を解除）は従来どおり出る
  vm.runInContext(`state.me = {id: 2}; state.detail = {request:{id:1,user_id:1,status:'open',registration_closed:true,participant_count:1,reported_count:0,approved_count:0,working_count:0,changes_requested_count:0,all_approved:false}, assignments:[{id:3,user_id:2,status:'joined',changeset_ids:[],like_count:0,liked_by_me:false}], events:[], supported_by_me:false}; renderDetail()`, context);
  assert.match(el('detail-actions').innerHTML, /act-leave/);
  assert.doesNotMatch(el('detail-actions').innerHTML, /act-join/);
  console.log('参加受付締め切りUI: OK');
});
