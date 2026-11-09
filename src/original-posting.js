/** Provenance is mandatory: aggregator text is never an original posting. */
export const ORIGINAL_REVISION=1;
export function isDiscoveryUrl(value) {
  try{return /(^|\.)(jobright\.ai|hiringcafe\.com|linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com)$/i.test(new URL(value).hostname);}catch{return true;}
}
export function originalSource(url,method,identity={}) {
  if(isDiscoveryUrl(url)||!/^https?:\/\//i.test(url))throw new Error('An original employer posting URL is required.');
  return {revision:ORIGINAL_REVISION,url,method,verifiedAt:Date.now(),...identity};
}
export function verifiedOriginal(job) {
  const source=job?.descriptionSource;
  return source?.revision===ORIGINAL_REVISION&&!isDiscoveryUrl(source.url)&&['official-api','employer-page'].includes(source.method)&&source.verifiedAt>0;
}
/** Refreshing an unchanged source must not regenerate its documents. */
export function originalKey(job) {
  const source=job?.descriptionSource;
  return source?{revision:source.revision,url:source.url,method:source.method,postingId:source.postingId}:null;
}
/** A failed API falls back only to its original posting page, never a feed. */
export async function readOriginalPosting(url,{api,readPage,minimum=200,log=()=>{}}={}) {
  if(isDiscoveryUrl(url))throw new Error('The original employer posting link could not be resolved.');
  if(api?.ids(url)) {
    let posting,unreachable=false;
    try {posting=await api.posting(url);}catch(error){unreachable=true;log(`Original posting API unavailable: ${error.message}; reading its page.`);}
    if(posting) {
      if(String(posting.jd||'').trim().length<minimum||!posting.title||!posting.company)throw new Error('The original posting returned incomplete description or employer information.');
      return {url,role:posting.title,company:posting.company,jd:posting.jd,metadata:posting.metadata||{},apply:{url:posting.applyUrl||url},descriptionSource:originalSource(api.pageUrl?.(url)||url,'official-api',{postingId:api.ids(url),title:posting.title,company:posting.company})};
    }
    if(!unreachable)throw Object.assign(new Error('The employer no longer lists this posting.'),{postingClosed:true});
  }
  const page=await readPage(api?.pageUrl?.(url)||url);
  if(page?.closed)throw Object.assign(new Error('The original employer posting has expired.'),{postingClosed:true});
  if(!page||isDiscoveryUrl(page.url)||page.ambiguousPosting||String(page.jd||'').trim().length<minimum||!page.role||!page.descriptionMethod||page.descriptionMethod==='body')throw new Error('The original employer page did not provide a complete, identifiable job description.');
  return {...page,descriptionSource:originalSource(page.url,'employer-page',{title:page.role,company:page.company||''})};
}
