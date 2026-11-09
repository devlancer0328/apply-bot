/** One retry budget per logical ChatGPT request, shared by all callers. */
export const CHATGPT_REFRESH_RETRIES = 3;
export async function withChatRecovery(work,{refresh,progress=()=>{},signal,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  for(let attempt=0;;attempt++) {
    if(signal?.aborted)throw Object.assign(new Error('The run was stopped.'),{status:499,retryable:false});
    try {return await work();}
    catch(error) {
      if(!error.chatRecovery||error.retryable===false||error.status===499)throw error;
      if(attempt>=CHATGPT_REFRESH_RETRIES) {
        error.message=`${error.message} Automatic recovery failed after ${CHATGPT_REFRESH_RETRIES} refresh retries.`;
        error.retryable=false;
        throw error;
      }
      const retry=attempt+1;
      progress({retry,limit:CHATGPT_REFRESH_RETRIES,message:error.message});
      await wait(1000*retry);
      if(signal?.aborted)throw Object.assign(new Error('The run was stopped.'),{status:499,retryable:false});
      // A failed reload consumes this attempt too; it must not create a
      // second, unbounded retry loop around the browser operation.
      try {await refresh(error,retry);} catch(refreshError) {
        if(refreshError.retryable===false||refreshError.status===499)throw refreshError;
        error.message=`${error.message} Refresh failed: ${refreshError.message}`;
      }
    }
  }
}
