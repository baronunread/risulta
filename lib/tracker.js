// SPDX-License-Identifier: MIT
export function trackerFor(publicKey) {
  return `/*! Risulta tracker — MIT */(()=>{let l="";const s=document.currentScript,e=new URL("/api/event/${publicKey}",s.src).href,f=()=>{const p=location.pathname+location.search;if(p===l)return;l=p;fetch(e,{method:"POST",mode:"cors",keepalive:true,headers:{"Content-Type":"text/plain"},body:JSON.stringify({name:"pageview",path:p,referrer:document.referrer,domain:location.hostname})}).catch(()=>{})};for(const k of["pushState","replaceState"]){const o=history[k];history[k]=function(){const r=o.apply(this,arguments);f();return r}}addEventListener("popstate",f);addEventListener("pageshow",e=>{if(e.persisted){l="";f()}});f()})();`;
}
