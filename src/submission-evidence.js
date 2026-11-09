/** Self-contained snapshot before clicking Submit; existing JD text is not a receipt. */
export function confirmationSnapshot(){
  const pattern=/thank you for applying|thanks for applying|thank you for (?:completing|submitting) your application|application (?:has been|was) (?:submitted|received)|we(?:'ve| have) received your application|application submitted|successfully submitted|you have successfully applied for this position/i;
  return (document.body?.innerText||'').split('\n').filter(line=>pattern.test(line)).map(line=>line.replace(/\s+/g,' ').trim()).slice(0,100);
}
export function newConfirmation(text,before=[]){
  const pattern=/thank you for applying|thanks for applying|thank you for (?:completing|submitting) your application|application (?:has been|was) (?:submitted|received)|we(?:'ve| have) received your application|application submitted|successfully submitted|you have successfully applied for this position/i;
  return String(text||'').split('\n').map(line=>line.replace(/\s+/g,' ').trim()).find(line=>pattern.test(line)&&!before.includes(line))||'';
}
/** Wizard navigation is not a receipt, and an old receipt is not a new send. */
export const confirmedWizardReceipt=(state,before=[])=>state?.kind==='done'&&Boolean(newConfirmation(state.quote,before));
