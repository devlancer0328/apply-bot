import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
const source=await readFile(new URL('../src/jobright.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function collect(rounds,'),source.indexOf('/** The tab the user keeps'));
/** A fixed-height virtual list: jumping to the bottom really loses middle cards. */
export function virtualFeed({count=30,slots,loaderUntil=0,growAt=0,network,applyUrl}={}) {
 const dom=parseHTML('<html><body><aside id="sidebar"></aside><div id="jobs"><div id="cards"></div></div></body></html>');
 let jobs=dom.document.getElementById('jobs'),cards=dom.document.getElementById('cards');const sidebar=dom.document.getElementById('sidebar');
 let clock=100000,top=0,height=count*500,reads=0;
 const positions=[];
 const installMetrics=()=>Object.defineProperties(jobs,{offsetWidth:{get:()=>800},clientHeight:{get:()=>500},scrollHeight:{get:()=>height},scrollTop:{get:()=>top,set:value=>{top=Math.max(0,Math.min(height-500,value));positions.push(top);render();}}});installMetrics();
 Object.defineProperties(sidebar,{offsetWidth:{get:()=>400},clientHeight:{get:()=>500},scrollHeight:{get:()=>50000},scrollTop:{value:0,writable:true}});
 const render=()=>{
  const index=Math.floor(top/500);const ids=slots?slots.filter(slot=>slot>=index&&slot<=index+1):[index,Math.min(count-1,index+1)];
  cards.innerHTML=ids.map(id=>{const apply=applyUrl?.(id);return `<div class="card"><a href="https://jobright.ai/jobs/info/${String(id).padStart(24,'a')}">Job ${id}</a>${apply?`<a href="${apply}">APPLY NOW</a>`:''}</div>`;}).join('');
  jobs.querySelector('[role=progressbar]')?.remove();
  if(clock<100000+loaderUntil){const loader=dom.document.createElement('div');loader.setAttribute('role','progressbar');Object.defineProperty(loader,'offsetWidth',{value:100});jobs.append(loader);}
 };
 render();
 const fakeWindow={innerHeight:500,scrollTo:()=>{},...(network?{__applyBotJobrightNetwork:network}:{} )};
 const collect=vm.runInNewContext('('+code+')',{window:fakeWindow,document:dom.document,location:{href:'https://jobright.ai/jobs/recommend',pathname:'/jobs/recommend'},URL,Date:{now:()=>clock},getComputedStyle:node=>({overflowY:node===jobs||node===sidebar?'auto':'visible'}),setTimeout:(callback,ms)=>{clock+=ms;reads++;if(growAt&&clock>=100000+growAt){height=(count+5)*500;}render();queueMicrotask(callback);}});
 return {collect,positions,window:fakeWindow,get jobs(){return jobs;},sidebar,now:()=>clock,setTop:v=>jobs.scrollTop=v,setHeight:v=>height=v,reads:()=>reads,replaceContainer:()=>{const replacement=jobs.cloneNode(true);jobs.replaceWith(replacement);jobs=replacement;cards=jobs.querySelector('#cards');top=0;installMetrics();render();}};
}
