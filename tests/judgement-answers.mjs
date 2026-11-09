/**
 * The line between a judgement question that may be answered and one that
 * may not.
 *
 * Every case here is a real required question off a real form that parked
 * a finished application on the night of 7 November. They are written as
 * pairs on purpose: for each one that now answers there is a neighbouring
 * question that must still park, because the only thing holding the
 * refusal in place is the test that notices when it stops happening. An
 * invented licence or a denied clearance is a false statement on a real
 * employer's form and cannot be taken back; a parked application costs one
 * posting.
 */
import assert from 'node:assert/strict';
import {resolveField,resolveForm} from '../src/answers.js';
import {withDefaults} from '../src/profile.js';

let count=0;
const test=(name,work)=>{work();console.log(`PASS ${name}`);count++;};

const PROFILE=withDefaults({
 firstName:'Daniel',lastName:'Torres',email:'d@example.com',phone:'+1 (929) 489-1252',
 city:'Temple',state:'TX',zip:'76501',country:'United States',
 workAuthorization:'us-citizen',requiresSponsorship:'no',over18:'yes',nonCompete:'no',backgroundCheck:'yes',
 willingToRelocate:'no',willingToTravel:'yes',startDate:'Two weeks after offer',howHeard:'Company website',techYears:9,
 educationSchool:'University of Texas - Austin',educationDegree:'Bachelor of Science in Computer Science (Software Engineering)',
 educationStart:'Aug 2011',educationEnd:'May 2015',
});
const CONTEXT={company:'Clear Street',title:'Software Engineer',resume:'',education:{degree:'',school:'',year:''}};
const ask=(label,extra={})=>({key:label,label,type:'text',required:true,options:[],...extra});
const yesNo=(label,extra={})=>ask(label,{type:'select',options:[{label:'Yes',value:'Yes'},{label:'No',value:'No'}],...extra});

/* ----------------------------------------- the ordinary denials, answered */

test('an attribute nothing claims and no regulator reads is denied rather than parked',()=>{
 const athlete=yesNo('Are you an athlete or esports competitor who participates in games or contests for which fantasy sports platforms or online sportsbooks offer the ability to make selections?');
 const resolved=resolveField(athlete,PROFILE,CONTEXT);
 assert.equal(resolved.outcome,'fill');
 assert.equal(resolved.rule,'judgement-default');
 assert.equal(resolved.value,'No');
 for(const label of [
  'Are you related to or in a personal relationship with a current employee of the company?',
  'Do you have any financial interest in or conflict of interest with any of our competitors?',
  'Are you currently represented by a recruiter or staffing agency for this role?',
 ]) assert.equal(resolveField(yesNo(label),PROFILE,CONTEXT).value,'No',label);
});

test('the same question asked as prose is left alone, because a paragraph box is not asking for a word',()=>{
 const essay={...ask('Are you an athlete or esports competitor? Describe your involvement.'),tag:'textarea',type:'textarea'};
 assert.equal(resolveField(essay,PROFILE,CONTEXT).outcome,'ask');
});

/* --------------------------------- the claims and regulated denials, parked */

test('a securities licence question still parks while the profile says nothing about licences',()=>{
 const held=yesNo('Do you currently hold or have previously held any securities industry licenses (ie - SEC, FINRA, NASAA, CFTC, NFA or other)?');
 const parked=resolveField(held,PROFILE,CONTEXT);
 assert.equal(parked.outcome,'blocked');
 assert.equal(parked.rule,'licenses');
 assert.match(parked.reason,/needs an answer the profile does not hold/);
 // And the judgement defaults must not reach around it once it is named.
 assert.notEqual(parked.rule,'judgement-default');
});

test('one word from the applicant answers the whole licence class, in each shape the form asks it',()=>{
 const stated={...PROFILE,licenses:'none'};
 assert.equal(resolveField(yesNo('Do you currently hold or have previously held any securities industry licenses (ie - SEC, FINRA, NASAA, CFTC, NFA or other)?'),stated,CONTEXT).value,'No');
 assert.equal(resolveField(ask('Please provide a list of licenses that you currently hold or have previously held. If you do not have any, please say "None."'),stated,CONTEXT).value,'None');
 const some={...PROFILE,licenses:'Series 7, Series 63'};
 assert.equal(resolveField(yesNo('Do you currently hold any securities industry licenses?'),some,CONTEXT).value,'Yes');
 assert.equal(resolveField(ask('Please list the licenses you hold.'),some,CONTEXT).value,'Series 7, Series 63');
});

test('a clearance and an identifier the profile cannot vouch for are never invented',()=>{
 for(const label of [
  'Do you currently hold or have you ever held an active US security clearance?',
  'What is your social security number?',
 ]) assert.equal(resolveField(yesNo(label),PROFILE,CONTEXT).outcome,'blocked',label);
});

/* ------------------------------------------------- the record, as stated */

test('a stated clean record answers the conviction questions, in each shape they are asked',()=>{
 // Not a guess off a resume: profile.criminalRecord is the applicant
 // saying it once, the same trade profile.licenses already makes.
 for(const label of [
  'Have you ever been convicted of a felony?',
  'Have you ever been convicted of a crime?',
  'Do you have any criminal convictions?',
  'Have you been convicted of a misdemeanor in the last 7 years?',
  'Are you currently under indictment?',
  'Have you ever pleaded guilty or no contest to a criminal offense?',
 ]){
  const resolved=resolveField(yesNo(label),PROFILE,CONTEXT);
  assert.equal(resolved.outcome,'fill',label);
  assert.equal(resolved.rule,'criminal-record',label);
  assert.equal(resolved.value,'No',label);
 }
});

test('a record the applicant has not spoken for still goes to a person',()=>{
 // Empty parks it as before, and "disclose" parks it too: a record that
 // exists is a sentence only the applicant writes.
 for(const criminalRecord of ['','disclose']){
  const resolved=resolveField(yesNo('Have you ever been convicted of a felony?'),{...PROFILE,criminalRecord},CONTEXT);
  assert.equal(resolved.outcome,'blocked',criminalRecord);
  assert.equal(resolved.rule,'criminal-record',criminalRecord);
 }
});

test('the record rule does not reach a clearance, a licence or a background-check consent',()=>{
 // Each of these keeps its own setting, and a clean record says nothing
 // about any of them.
 assert.equal(resolveField(yesNo('Do you consent to a criminal background check?'),PROFILE,CONTEXT).rule,'background-check');
 assert.equal(resolveField(yesNo('Do you currently hold an active security clearance?'),PROFILE,CONTEXT).outcome,'blocked');
 assert.equal(resolveField(yesNo('Do you hold any securities industry licenses?'),PROFILE,CONTEXT).rule,'licenses');
});

/* -------------------------------------- nobody this applicant knows works there */

test('a conflict screen about the household is denied however it names the household',()=>{
 // The employee-worded ones already answered; these name only a relative
 // and the company, which reached no rule and parked finished forms.
 for(const label of [
  'Do you have any relatives who work at Clear Street?',
  'Do you have relatives employed by this company?',
  'Do you have any relatives at this company?',
  'Is your spouse or domestic partner employed by Clear Street?',
  'Do you have a family member working here?',
  'Do you have any friends or family at the company?',
  'Has any member of your household ever worked for us?',
  'Are you a relative of a current or former employee?',
 ]){
  const resolved=resolveField(yesNo(label),PROFILE,CONTEXT);
  assert.equal(resolved.outcome,'fill',label);
  assert.equal(resolved.value,'No',label);
 }
});

test('the household rule does not swallow the channel question or the applicant\'s own history',()=>{
 assert.equal(resolveField({...ask('How did you hear about this opportunity?'),type:'select',options:[{label:'Company website',value:'1'},{label:'LinkedIn',value:'2'}]},PROFILE,CONTEXT).value,'1');
 // "Have you worked here before" is about the applicant, not a relative,
 // and keeps its own rule and its own evidence.
 assert.equal(resolveField(yesNo('Have you ever worked for this company before?'),PROFILE,CONTEXT).rule,'previous-employment');
});

test("a driving licence is not a credential this answers, so it still goes to a person",()=>{
 const driving=yesNo("Do you have a valid driver's license?");
 const resolved=resolveField(driving,{...PROFILE,licenses:'none'},CONTEXT);
 assert.notEqual(resolved.rule,'licenses');
});

/* -------------------------------------------------- conditional follow-ups */

const HOW_HEARD={key:'how',label:'How did you hear about this opportunity?',type:'select',required:true,
 options:[{label:'Company website',value:'1'},{label:'LinkedIn',value:'2'},{label:'Clear Street Employee',value:'3'},{label:'Other',value:'4'}]};
const FOLLOW_UP=ask('If you selected "Clear Street Employee" or "Other" please let us know the name of the employee or more information on "Other" respectively. If you did not select "Clear Street Employee" or "Other" please write N/A.');

test("a follow-up whose trigger nothing on this form selects is answered with the word the form asked for",()=>{
 const plan=resolveForm([HOW_HEARD,FOLLOW_UP],PROFILE,CONTEXT);
 assert.equal(plan.blocked.length,0);
 assert.equal(plan.questions.length,0);
 const answer=plan.fills.find((fill)=>fill.key===FOLLOW_UP.key);
 assert.equal(answer.value,'N/A');
 assert.equal(answer.rule,'conditional-followup');
 assert.equal(plan.fills.find((fill)=>fill.key==='how').value,'1');
});

test('a follow-up whose trigger this form could still select is left exactly as it was',()=>{
 const onlyOther={...HOW_HEARD,options:[{label:'Other',value:'4'}]};
 const plan=resolveForm([onlyOther,FOLLOW_UP],PROFILE,CONTEXT);
 assert.ok(plan.fills.every((fill)=>fill.key!==FOLLOW_UP.key));
 assert.ok(plan.questions.some((question)=>question.key===FOLLOW_UP.key)||plan.blocked.some((entry)=>entry.key===FOLLOW_UP.key));
});

test('an unconditional "if not applicable, enter N/A" needs no trigger at all',()=>{
 const field=ask('Referring employee name. If not applicable, please enter N/A.');
 const plan=resolveForm([field],PROFILE,CONTEXT);
 assert.equal(plan.fills[0]?.value,'N/A');
});

test('an optional follow-up is still left blank, since nothing is gained by writing in it',()=>{
 const plan=resolveForm([HOW_HEARD,{...FOLLOW_UP,required:false}],PROFILE,CONTEXT);
 assert.ok(plan.fills.every((fill)=>fill.key!==FOLLOW_UP.key));
});

/* ------------------------------------------------------------ the bank */

test('a stated answer reaches a question no rule and no stored fact could',()=>{
 const stated={...PROFILE,answerBank:'security clearance = No, I have never held one\nathlete = Yes'};
 const clearance=ask('Do you currently hold or have previously held any security clearance?');
 assert.equal(resolveField(clearance,stated,CONTEXT).value,'No, I have never held one');
 // And it overrides a shipped default, which is the point of being able to state one.
 assert.equal(resolveField(yesNo('Are you an athlete or esports competitor?'),stated,CONTEXT).value,'Yes');
});

test('the bank cannot swallow a document upload or a field it was not aimed at',()=>{
 const stated={...PROFILE,answerBank:'resume = No\nx = y'};
 assert.equal(resolveField({key:'cv',label:'Resume/CV',type:'file',required:true,options:[]},stated,CONTEXT).outcome,'attach');
 assert.equal(resolveField(ask('Email'),stated,CONTEXT).value,PROFILE.email);
});

/* ------------------------------------- the three that were not judgement at all */

test('a required preferred name is the first name, and an optional one is still left alone',()=>{
 // MongoDB parked a finished application on this box. There is no judgement
 // in it: a preferred name the applicant has not stated is their first name.
 assert.equal(resolveField(ask('Preferred Name'),PROFILE,CONTEXT).value,'Daniel');
 assert.equal(resolveField(ask('Preferred Name',{required:false}),PROFILE,CONTEXT).outcome,'skip');
});

test('an employer whose name contains a form field is not mistaken for one',()=>{
 // "Will you now or in the future require Clear Street to sponsor..." parked
 // because the street-address rule saw the company's own name in the question.
 const sponsor=yesNo('Will you now or in the future require Clear Street to sponsor an employment visa on your behalf to commence or continue employment?');
 const resolved=resolveField(sponsor,PROFILE,CONTEXT);
 assert.equal(resolved.rule,'sponsorship');
 assert.equal(resolved.value,'No');
});

test('whether this application came through an employee is a fact this system holds',()=>{
 // It came off a job feed, so the answer is No and nothing about the
 // applicant's acquaintances is being claimed either way.
 assert.equal(resolveField(yesNo('Did you hear about this opportunity from a current DailyPay employee?'),PROFILE,CONTEXT).value,'No');
 // The channel menu beside it is still the channel menu.
 assert.equal(resolveField({...ask('How did you hear about this opportunity?'),type:'select',options:[{label:'Company website',value:'1'},{label:'LinkedIn',value:'2'}]},PROFILE,CONTEXT).value,'1');
});

/* --------------------------------------------------------- the degree */

test('the education block answers from the profile when the generated resume carries none',()=>{
 const rows=[
  ['School','school--0','University of Texas - Austin'],
  ['Degree','degree--0',"Bachelor's of Science (B.S)"],
  ['Discipline','discipline--0','Computer Science'],
  ['Start Year','start_year--0','2011'],
  ['End Year','end_year--0','2015'],
  ['Start Month','start_month--0','August'],
  ['End Month','end_month--0','May'],
 ];
 for(const [label,name,expected] of rows){
  const resolved=resolveField(ask(label,{name}),PROFILE,CONTEXT);
  assert.equal(resolved.outcome,'fill',label);
  assert.equal(resolved.candidates[0],expected,label);
 }
});

test('a resume that does state a degree still wins, and its dates are not mixed with the profile\'s',()=>{
 const context={...CONTEXT,education:{degree:'Master of Science in Data Science',school:'Rice University',year:'2019'}};
 assert.equal(resolveField(ask('School',{name:'school--0'}),PROFILE,context).value,'Rice University');
 assert.equal(resolveField(ask('Start Year',{name:'start_year--0'}),PROFILE,context).value,'2017');
 assert.equal(resolveField(ask('Start Month',{name:'start_month--0'}),PROFILE,context).candidates[0],'September');
});

console.log(`${count} judgement-answer checks passed.`);
