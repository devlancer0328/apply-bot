/** Discovery completion depends on new URLs, even when no jobs pass filters. */
export class DiscoveryRounds {
  constructor(sourceCount){this.sourceCount=sourceCount;this.seen=new Set();this.empty=new Set();this.failures=new Map();this.passNew=new Map();}
  observe(ids){let count=0;for(const id of ids.filter(Boolean)){if(!this.seen.has(id)){this.seen.add(id);count++;}}return count;}
  success(source,newCount,complete=true){
    this.failures.set(source,0);if(newCount>0)this.empty.clear();
    const passNew=(this.passNew.get(source)||0)+newCount;
    if(complete){this.passNew.delete(source);if(passNew>0)this.empty.delete(source);else this.empty.add(source);}
    else{this.passNew.set(source,passNew);this.empty.delete(source);}
    return this.sourceCount>0&&this.empty.size>=this.sourceCount;
  }
  failure(source){this.empty.clear();const count=(this.failures.get(source)||0)+1;this.failures.set(source,count);return count>=3;}
  /**
   * A source the run has given up on. Its slot has to leave the count as
   * well as the rotation: "every enabled source found nothing new" is what
   * ends a run, and a source that is no longer being read can never report
   * an empty round, so leaving it counted means the run can never finish.
   */
  retire(source){this.sourceCount=Math.max(0,this.sourceCount-1);this.empty.delete(source);this.passNew.delete(source);this.failures.delete(source);}
}
export function runSummary(run){return run?.running&&run?.stopping?'Stop requested. Waiting for active operations to finish; no further forms will start.':run?.stopReason?.message||(run?.running?'Run in progress.':'No run recorded yet.');}
export function elapsedText(ms){const seconds=Math.max(0,Math.floor(ms/1000));return seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;}
/** Confirmed sends have a separate limit; uncertain sends never satisfy it. */
export function runCapacity(profile,state){
  const attempts=profile.maxPerRun>0?Math.max(0,profile.maxPerRun-(state.attempted||0)):Number.MAX_SAFE_INTEGER;
  const confirmed=profile.maxSubmittedPerRun>0?Math.max(0,profile.maxSubmittedPerRun-(state.submitted||0)):Number.MAX_SAFE_INTEGER;
  return Math.min(attempts,confirmed);
}
