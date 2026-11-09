/** Passive observer: only Jobright's recommendation/search job-list requests. */
(()=>{
  if(window.__applyBotJobrightNetwork?.revision===4)return;
  let generation=0,state;
  const reset=()=>{generation++;state={inflight:0,version:0,lastActivityAt:0,hasMore:null,terminal:false,error:null,ids:[],entries:[],scope:''};};
  reset();
  // `/swan/recommend/list/jobs` was the only list address when this was
  // written and the site has since grown siblings beside it - tnt, similar,
  // auto-apply, visitor-list - each answering with the same job shape. A
  // path that named one of them left the observer watching an endpoint the
  // page no longer calls, which reads downstream as "the feed named no board
  // for any of forty jobs" rather than as "nothing was observed at all". The
  // segment is still bounded so that none of the other hundred `/swan/`
  // endpoints, several of which submit, can match.
  const relevant=value=>{try{const u=new URL(typeof value==='string'?value:value?.url,location.href);return /(^|\.)jobright\.ai$/i.test(u.hostname)&&/^\/swan\/(?:recommend|search)\/[a-z0-9-]+\/jobs\/?$/i.test(u.pathname);}catch{return false;}};
  const key=k=>String(k).toLowerCase().replace(/[^a-z0-9]/g,'');
  const scopeOf=(url,body)=>{
    try {
      const strip=value=>Array.isArray(value)?value.map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!/^(page|pagenum|pagenumber|pageindex|pagesize|cursor|nextcursor|offset|limit|lastjobid|start|size|position|count|refresh|timestamp|ts)$/.test(key(k))).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,strip(v)])):value;
      const u=new URL(url,location.href);const data={path:u.pathname,query:strip(Object.fromEntries(u.searchParams)),body:body?strip(JSON.parse(body)):null};
      let hash=2166136261;for(const c of JSON.stringify(data))hash=Math.imul(hash^c.charCodeAt(0),16777619);return (hash>>>0).toString(16);
    }catch{return '';}
  };
  const inspect=(payload,scope)=>{
    if(payload?.success===false){state.error='Jobright reported an unsuccessful job-list response. Check the source tab and sign-in.';return;}
    const arrays=[],containers=[];
    const walk=(value,depth=0)=>{
      if(!value||typeof value!=='object'||Array.isArray(value)||depth>3)return;
      containers.push(value);
      for(const [name,child]of Object.entries(value)) {
        if(Array.isArray(child)&&/^(jobs|joblist|jobitems|jobresults|records|results|list|items)$/.test(key(name)))arrays.push(child);
        else if(child&&typeof child==='object'&&!Array.isArray(child))walk(child,depth+1);
      }
    };
    walk(payload);
    // Authentication responses, statistics and unknown payloads cannot prove an end.
    if(!arrays.length)return;
    const jobs=arrays.flat(),ids=jobs.map(j=>j?.jobId||j?.job_id||j?.id||j?.jobResult?.jobId||j?.jobInfo?.jobId||j?.job?.jobId).filter(id=>typeof id==='string'&&/^[a-f0-9]{24}$/i.test(id));
    if(jobs.length&&!ids.length)return;
    let hasMore=null;
    for(const object of containers)for(const [name,value]of Object.entries(object)) {
      const k=key(name);
      if(['hasmore','hasnext','hasnextpage'].includes(k)&&typeof value==='boolean')hasMore=value;
      if(['islast','islastpage'].includes(k)&&typeof value==='boolean')hasMore=!value;
    }
    if(state.scope&&scope&&scope!==state.scope){state.ids=[];state.entries=[];}
    const hints=new Map(state.entries.map(entry=>[entry.id,entry]));
    for(const job of jobs){
      const root=job?.jobResult||job?.jobInfo||job?.job||job,id=job?.jobId||job?.job_id||job?.id||root?.jobId;
      if(typeof id!=='string'||!/^[a-f0-9]{24}$/i.test(id))continue;
      const fields=Object.fromEntries(Object.entries(root||{}).map(([k,v])=>[key(k),v]));
      const string=(...values)=>values.find(value=>typeof value==='string'&&value.trim())?.trim()||'';
      const company=string(fields.companyname,fields.employername,fields.company?.name,job.companyResult?.companyName,fields.company),title=string(fields.jobtitle,fields.positiontitle,fields.title);
      // `applyLink` first, because that is the field Jobright's own card
      // reads before it opens the employer's site, and the four names that
      // used to be here are ones it does not publish - which is why the feed
      // named a board for none of a night's four hundred jobs. The rest stay
      // as a fallback against the name changing again.
      let originalUrl='';
      for(const value of [fields.applylink,fields.originalurl,fields.externalapplyurl,fields.applyurl,fields.jobapplyurl,fields.atsurl]){
        try{const url=new URL(value);if(/^https?:$/.test(url.protocol)&&!url.username&&!url.password&&!/(^|\.)(jobright\.ai|linkedin\.com|hiringcafe\.com)$/.test(url.hostname)){originalUrl=url.href;break;}}catch{}
      }
      // Whether the feed claims an employer link at all is worth carrying
      // even when it gives none: a card marked as having none is one the
      // run can decline without spending a tab proving it.
      const companySiteLink=typeof fields.iscompanysitelink==='boolean'?fields.iscompanysitelink:undefined;
      hints.set(id,{...hints.get(id),id,...(company?{company:company.slice(0,300)}:{}),...(title?{title:title.slice(0,500)}:{}),...(originalUrl?{originalUrl}:{}),...(companySiteLink===undefined?{}:{companySiteLink})});
    }
    state.entries=[...hints.values()];
    state.scope=scope||state.scope;state.ids=[...new Set([...state.ids,...ids])];
    state.hasMore=hasMore;state.terminal=hasMore===false;state.error=null;state.version++;state.lastActivityAt=Date.now();
  };
  const begin=scope=>{
    if(scope&&state.scope&&scope!==state.scope){state.ids=[];state.entries=[];state.version++;}
    state.scope=scope||state.scope;state.terminal=false;state.hasMore=null;state.error=null;
    const token=generation;state.inflight++;state.lastActivityAt=Date.now();return token;
  };
  const finish=(token,payload,scope,status,error)=>{
    if(token!==generation)return;
    state.inflight=Math.max(0,state.inflight-1);state.lastActivityAt=Date.now();
    if(scope&&state.scope&&scope!==state.scope)return;
    if(error||status>=400){state.error=error||'Jobright job-list request returned '+status;return;}
    inspect(payload,scope);
  };
  const originalFetch=window.fetch;
  if(typeof originalFetch==='function')window.fetch=function(input,options){
    if(!relevant(input))return originalFetch.apply(this,arguments);
    const scope=scopeOf(typeof input==='string'?input:input.url,options?.body),token=begin(scope);
    return originalFetch.apply(this,arguments).then(response=>{
      response.clone().json().then(payload=>finish(token,payload,scope,response.status),()=>finish(token,null,scope,response.status,'Jobright returned unreadable job-list data.'));
      return response;
    },error=>{finish(token,null,scope,0,error.message);throw error;});
  };
  const xhr=window.XMLHttpRequest?.prototype;
  if(xhr){
    const open=xhr.open,send=xhr.send;
    xhr.open=function(method,url,...args){this.__applyBotFeedUrl=url;return open.call(this,method,url,...args);};
    xhr.send=function(body){
      if(!relevant(this.__applyBotFeedUrl))return send.apply(this,arguments);
      const scope=scopeOf(this.__applyBotFeedUrl,body),token=begin(scope);let done=false;
      const end=()=>{if(done)return;done=true;try{finish(token,this.responseType==='json'?this.response:JSON.parse(this.responseText),scope,this.status);}catch{finish(token,null,scope,this.status,'Jobright returned unreadable job-list data.');}};
      this.addEventListener('loadend',end,{once:true});
      try{return send.apply(this,arguments);}catch(error){done=true;finish(token,null,scope,0,error.message);throw error;}
    };
  }
  window.__applyBotJobrightNetwork={revision:4,reset,snapshot:()=>({...state,generation,ids:[...state.ids],entries:state.entries.map(entry=>({...entry}))})};
})();
