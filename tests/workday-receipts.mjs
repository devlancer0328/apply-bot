import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {confirmedWizardReceipt,confirmationSnapshot} from '../src/submission-evidence.js';
const source=await readFile(new URL('../src/workday.js',import.meta.url),'utf8');
let count=0;const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};
function fixture(html,url='https://example.wd1.myworkdayjobs.com/en-US/Careers/job/Engineer_R1'){const {document,window}=parseHTML('<html><body>'+html+'</body></html>');delete window.__wdApply;vm.runInNewContext(source,{document,window,location:{href:url},setTimeout});return {state:window.__wdApply.state(),before:vm.runInNewContext('('+confirmationSnapshot.toString()+')()',{document})};}
await test('A successful guest application remains a receipt when Workday offers optional account creation',()=>{
 const html='<main data-automation-id="pageMainContent">Search jobs</main><div role="dialog"><h2>Congratulations!</h2><p>You have successfully applied for this position. Thank you.</p><button data-automation-id="createAccountSubmitButton">Create Account</button></div>';
 const {state,before}=fixture(html,'https://example.wd1.myworkdayjobs.com/Careers?Job_Application_ID=new-application');
 assert.equal(state.kind,'done');assert.equal(confirmedWizardReceipt(state),true);assert.equal(confirmedWizardReceipt(state,before),false);
 assert.equal(fixture(html).state.kind,'create');
 assert.notEqual(fixture(html.replace('You have successfully applied for this position. Thank you.','Congratulations on joining our award-winning team.'),'https://example.wd1.myworkdayjobs.com/Careers?Job_Application_ID=old').state.kind,'done');
 const review=html.replace('<main data-automation-id="pageMainContent">Search jobs</main>','<main data-automation-id="applyFlowPage"><section data-automation-id="applyFlowReviewPage">Review</section><button data-automation-id="pageFooterNextButton">Submit</button></main>');
 assert.notEqual(fixture(review,'https://example.wd1.myworkdayjobs.com/Careers?Job_Application_ID=old').state.kind,'done');
});
await test('Leaving Workday review for loading, posting or an unknown page cannot confirm submission',()=>{
 for(const kind of ['unknown','posting','form','review'])assert.equal(confirmedWizardReceipt({kind,quote:'Thank you for applying'}),false);
 assert.equal(confirmedWizardReceipt({kind:'done',quote:''}),false);
});
await test('Congratulatory job text and receipt wording on the posting are not completed applications',()=>{
 for(const html of ['<main><h1>Congratulations on our award-winning team</h1></main>','<main data-automation-id="pageMainContent"><div data-automation-id="jobPostingDescription">Thank you for applying. Please complete this job application.</div><button data-automation-id="adventureButton">Apply</button></main>'])assert.notEqual(fixture(html).state.kind,'done');
});
await test('Workday review questions quoting receipt wording remain review pages',()=>{
 const {state}=fixture('<main data-automation-id="applyFlowPage"><section data-automation-id="applyFlowReviewPage">Thank you for applying. Review these answers.</section><button data-automation-id="pageFooterNextButton">Submit</button></main>');assert.equal(state.kind,'review');assert.equal(confirmedWizardReceipt(state),false);
});
await test('An actual Workday receipt produces a complete quote that matches the pre-submit snapshot format',()=>{
 const {state,before}=fixture('<main data-automation-id="pageMainContent"><h1>Thank you for applying</h1><p>We have received your application.</p></main>');assert.equal(state.kind,'done');assert.equal(confirmedWizardReceipt(state),true);assert.equal(confirmedWizardReceipt(state,before),false);
});
await test('Each tenant\'s own wording for the receipt is read as one',()=>{
 // Both off live tenants. OneSource Virtual's dialog matched nothing here,
 // so an application it had taken came back uncertain - which in a queue
 // that retries the unconfirmed is how a company gets applied to twice.
 for(const html of ['<main data-automation-id="pageMainContent"><h2>Application Submitted</h2><p>Thank you for completing your application.</p></main>','<main data-automation-id="pageMainContent"><h2>Application Submitted</h2><p>Your application has been successfully submitted!</p></main>']){
  const {state,before}=fixture(html);assert.equal(state.kind,'done',html);assert.equal(confirmedWizardReceipt(state),true);assert.equal(confirmedWizardReceipt(state,before),false);
 }
});
const background=await readFile(new URL('../src/background.js',import.meta.url),'utf8'),start=background.indexOf('async function runWorkday('),driver=background.slice(start,background.indexOf('\n/*',start));
async function drive({initial='review',after='unknown',before=[]}={}){
 let now=10000,clicked=0,claims=0,result,kind=initial;
 class Clock extends Date{static now(){return now;}}
 const current=()=>({kind,step:kind==='review'?'Review':'',quote:kind==='done'?'Thank you for applying':'',loading:false,errors:{heading:'',alerts:[]},drawn:0,menus:'',url:'https://example.wd1.myworkdayjobs.com/apply'});
 const chrome={scripting:{executeScript:async args=>{if(args.files)return [];if(args.func?.name==='confirmationSnapshot')return [{result:before}];const method=args.args?.[0];if(method==='state')return [{result:current()}];if(method==='next'){clicked++;kind=after;return [{result:{clicked:true}}];}throw new Error('Unexpected Workday method '+method);}}};
 const run=vm.runInNewContext('('+driver+')',{chrome,Date:Clock,wait:async ms=>{now+=ms;},hostOf:url=>new URL(url).hostname,stateStorage:{get:async()=>({}),set:async()=>{}},openTab:async()=>7,resident:()=>{},workdayApplyUrl:url=>url,log:()=>{},attemptTabs:new Map(),claimSubmission:async()=>{claims++;return {claimed:true};},confirmationSnapshot,confirmedWizardReceipt,finishTab:async()=>{},keptForPerson:()=>false,AiError:class extends Error{}});
 const output=await run({company:'Example',applyUrl:'https://example.wd1.myworkdayjobs.com/apply'},{workdayPassword:'fixture-only',street:'Fixture street',email:'fixture@example.test'},{},{finish:(status,reason,detail={})=>(result={status,reason,detail}),archived:async value=>value,getResult:()=>result});
 return {output,clicked,claims};
}
await test('The actual Workday driver keeps navigation-only outcomes unconfirmed after Submit',async()=>{
 for(const after of ['unknown','posting','form']){const result=await drive({after});assert.equal(result.output.status,'unconfirmed');assert.equal(result.clicked,1);assert.equal(result.claims,1);}
});
await test('The actual Workday driver counts only a new receipt and protects a receipt found before Submit',async()=>{
 assert.equal((await drive({after:'done'})).output.status,'submitted');
 assert.equal((await drive({after:'done',before:['Thank you for applying']})).output.status,'unconfirmed');
 const prior=await drive({initial:'done'});assert.equal(prior.output.status,'unconfirmed');assert.equal(prior.output.detail.alreadyCompleted,true);assert.equal(prior.clicked,0);assert.equal(prior.claims,1);
});
console.log(`${count} Workday receipt checks passed.`);
