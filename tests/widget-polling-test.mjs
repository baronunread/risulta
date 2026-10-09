import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const nodes=new Map();
for(const selector of ['[data-status]','[data-current]','[data-visitors]','[data-pageviews]','.line','.area','.domain','.dot','.card']){
 nodes.set(selector,{textContent:'original',attributes:{},setAttribute(name,value){this.attributes[name]=value;},classList:{add(){},remove(){}}});
}
const timers=new Map(),events=new Map();let id=0,requests=0,response;
const parent={};
const document={hidden:false,querySelector(selector){return nodes.get(selector);},addEventListener(name,fn){events.set(name,fn);}};
const window={parent,addEventListener(name,fn){events.set(name,fn);}};
const success=()=>({ok:true,status:200,json:async()=>({current:12,visitors:2076,pageviews:4858,days:[1,3,2,5,4,7,6],domain:'example.test'})});
response=success();
runInNewContext(readFileSync('public/widget-frame.js','utf8'),{
 document,window,location:{pathname:'/public/widget/key'},AbortController,
 setTimeout(fn,ms){const key=++id;timers.set(key,{fn,ms});return key;},clearTimeout(key){timers.delete(key);},
 fetch:async(url,options)=>{requests++;assert.equal(url,'/public/data/key');assert.equal(options.credentials,'omit');return response;},
});
async function poll(){const [key,timer]=[...timers].find(([,v])=>v.ms===60000);timers.delete(key);timer.fn();await new Promise(setImmediate);}
assert.equal(requests,0);await poll();assert.equal(requests,1);
assert.equal(nodes.get('[data-visitors]').textContent,'2,076');assert.ok(nodes.get('.line').attributes.d.includes(' C'));
const savedLine=nodes.get('.line');
document.hidden=true;events.get('visibilitychange')();assert.equal(timers.size,0);
document.hidden=false;events.get('visibilitychange')();await new Promise(setImmediate);assert.equal(requests,2);assert.equal(nodes.get('.line'),savedLine);
events.get('message')({source:parent,data:{type:'risulta-widget-visibility',visible:false}});assert.equal(timers.size,0);
events.get('message')({source:parent,data:{type:'risulta-widget-visibility',visible:true}});await new Promise(setImmediate);assert.equal(requests,3);
response={ok:false,status:503};await poll();assert.equal(nodes.get('[data-status]').textContent,'Update delayed');assert.equal(nodes.get('[data-visitors]').textContent,'2,076');
response=success();await poll();assert.equal(nodes.get('[data-status]').textContent,'Last 7 days · UTC');
response={ok:false,status:404};await poll();assert.equal(nodes.get('.card').textContent,'Public sharing is unavailable.');assert.equal(timers.size,0);
console.log('Widget polling OK (in-place updates, no overlap, hidden/offscreen pause, immediate resume, retries and revocation)');
