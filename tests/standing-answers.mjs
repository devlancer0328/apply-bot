/**
 * The two questions that held three applications in a quarter of an hour,
 * and the refusals that have to survive fixing them.
 *
 * Both came off live Greenhouse forms on the night of 8 November.
 * BetterHelp asks "Are you located in and able to work in the US without
 * visa sponsorship for the next 5 years?" - a question the profile answers
 * outright, held anyway because "able to work in" is also how the onsite
 * rule reads a commute. Smartsheet asks "Do you know anyone who works at
 * Smartsheet?" - a question no profile can ever hold, held because it went
 * to the model as an open one.
 *
 * The fix for the first is matching and the fix for the second is a
 * default, and they fail in opposite directions, so both directions are
 * asserted here. A citizen must answer yes; somebody who needs sponsorship
 * must answer no to the same sentence rather than inheriting the citizen's
 * yes; a visa holder asked to speak for five years must still park,
 * because a visa has a date on it and nobody has granted the renewal. And
 * a clearance, which is the shape of question none of this is allowed to
 * reach, must still stop the application.
 */
import assert from 'node:assert/strict';
import {resolveField,standingAnswers} from '../src/answers.js';
import {withDefaults} from '../src/profile.js';
import {profile as profilePage} from '../src/ui/pages.js';

let count=0;
const test=(name,work)=>{work();console.log(`PASS ${name}`);count++;};

const BASE={
 firstName:'Daniel',lastName:'Torres',email:'d@example.com',phone:'+1 (929) 489-1252',
 city:'Temple',state:'TX',zip:'76501',country:'United States',
 over18:'yes',nonCompete:'no',backgroundCheck:'yes',willingToRelocate:'no',willingToTravel:'yes',
 startDate:'Two weeks after offer',howHeard:'Company website',techYears:9,
};
const CITIZEN=withDefaults({...BASE,workAuthorization:'us-citizen',requiresSponsorship:'no'});
const RESIDENT=withDefaults({...BASE,workAuthorization:'permanent-resident',requiresSponsorship:'no'});
const VISA=withDefaults({...BASE,workAuthorization:'visa-holder',requiresSponsorship:'no'});
const NEEDS=withDefaults({...BASE,workAuthorization:'needs-sponsorship',requiresSponsorship:'yes'});
const ABROAD=withDefaults({...BASE,city:'Toronto',state:'',country:'Canada',workAuthorization:'us-citizen',requiresSponsorship:'no'});
const UNSTATED=withDefaults({...BASE,workAuthorization:'',requiresSponsorship:''});

const CONTEXT={company:'BetterHelp',title:'Software Engineer',resume:'',education:{degree:'',school:'',year:''}};
const ask=(label,extra={})=>({key:label,label,type:'text',required:true,options:[],...extra});
const yesNo=(label,extra={})=>ask(label,{type:'select',options:[{label:'Yes',value:'Yes'},{label:'No',value:'No'}],...extra});

const BETTERHELP='Are you located in and able to work in the US without visa sponsorship for the next 5 years?';

/* ------------------------------------- located, authorized, and the span */

test('the BetterHelp question answers yes from a recorded citizenship, on a menu and in a box',()=>{
 for(const field of [yesNo(BETTERHELP),ask(BETTERHELP)]){
  const resolved=resolveField(field,CITIZEN,CONTEXT);
  assert.equal(resolved.outcome,'fill');
  assert.equal(resolved.rule,'located-and-authorized');
  assert.equal(resolved.candidates[0],'Yes');
 }
 assert.equal(resolveField(yesNo(BETTERHELP),RESIDENT,CONTEXT).value,'Yes');
});

test('the same sentence answers no for somebody who needs sponsorship, not yes',()=>{
 // The whole hazard of a default: a question answered from the applicant
 // in front of it, never from the applicant it was written for.
 const resolved=resolveField(yesNo(BETTERHELP),NEEDS,CONTEXT);
 assert.equal(resolved.outcome,'fill');
 assert.equal(resolved.value,'No');
});

test('living somewhere else is a no however good the authorization is',()=>{
 assert.equal(resolveField(yesNo(BETTERHELP),ABROAD,CONTEXT).value,'No');
});

test('a visa holder asked to speak for the next five years parks instead of promising a renewal',()=>{
 const parked=resolveField(yesNo(BETTERHELP),VISA,CONTEXT);
 assert.equal(parked.outcome,'blocked');
 assert.equal(parked.rule,'located-and-authorized');
 // Without the span it is a question about today, which the visa answers.
 assert.equal(resolveField(yesNo('Are you located in and able to work in the US without visa sponsorship?'),VISA,CONTEXT).value,'Yes');
});

test('a profile that has recorded no status at all still holds the application',()=>{
 assert.equal(resolveField(yesNo(BETTERHELP),UNSTATED,CONTEXT).outcome,'blocked');
});

test('"able to work ... without sponsorship" reaches authorization rather than inverting through sponsorship',()=>{
 // The Ondo incident with a plainer verb. Answered off the sponsorship
 // rule this reads "I am not able to work here", which is the opposite of
 // the truth and cannot be withdrawn once the form is sent.
 const field=yesNo('Are you able to work in the United States without requiring visa sponsorship?');
 assert.equal(resolveField(field,CITIZEN,CONTEXT).rule,'authorization');
 assert.equal(resolveField(field,CITIZEN,CONTEXT).value,'Yes');
 assert.equal(resolveField(field,NEEDS,CONTEXT).value,'No');
});

test('the sponsorship wordings that were always right are untouched',()=>{
 // Named both words, but the qualifier is not negated, so it is a
 // sponsorship question and stays one.
 const scale=yesNo('Will you now or in the future require work authorization or employment sponsorship?');
 assert.equal(resolveField(scale,CITIZEN,CONTEXT).rule,'sponsorship');
 assert.equal(resolveField(scale,CITIZEN,CONTEXT).value,'No');
 assert.equal(resolveField(scale,NEEDS,CONTEXT).value,'Yes');
 const ondo=yesNo('Are you currently authorized to work in the United States without the need for employer sponsorship?');
 assert.equal(resolveField(ondo,CITIZEN,CONTEXT).rule,'authorization');
 assert.equal(resolveField(ondo,CITIZEN,CONTEXT).value,'Yes');
});

test('a sentence that only has one question in it is not read as the conjunction',()=>{
 // Both of these put a place and a right to work in one line and neither
 // asks where the applicant is. The first cut of the conjunction rule took
 // both, and took Vercel's status menu out of the authorization rule that
 // knows how to read it.
 const vercel={key:'v',label:'Your authorization to work in the country where you live.',type:'select',required:true,
  options:[{label:'I am authorized to work in the country due to my nationality',value:'1'},{label:'I am not authorized to work in the country and need visa support',value:'2'}]};
 assert.equal(resolveField(vercel,CITIZEN,CONTEXT).rule,'authorization');
 assert.equal(resolveField(vercel,CITIZEN,CONTEXT).candidates[0],'I am authorized to work in the country due to my nationality');
 const digicert=yesNo('Are you legally authorized to work in the country in which this role is located?');
 assert.equal(resolveField(digicert,CITIZEN,CONTEXT).rule,'authorization');
 assert.equal(resolveField(digicert,CITIZEN,CONTEXT).value,'Yes');
});

test('a question about getting to an office is still a question about getting to an office',()=>{
 const here=resolveField(yesNo('Are you able to work from our Austin office?'),withDefaults({...BASE,city:'Austin',workAuthorization:'us-citizen',requiresSponsorship:'no'}),CONTEXT);
 assert.equal(here.rule,'onsite-proximity');
 assert.equal(here.value,'Yes');
 // And one naming a city the profile cannot be placed against still parks.
 assert.equal(resolveField(yesNo('Are you able to work from our Boston office?'),CITIZEN,CONTEXT).outcome,'blocked');
});

test('a plain residence question keeps answering from the country alone',()=>{
 assert.equal(resolveField(yesNo('Do you currently reside in the United States?'),CITIZEN,CONTEXT).value,'Yes');
 assert.equal(resolveField(yesNo('Do you currently reside in the United States?'),ABROAD,CONTEXT).value,'No');
 // A profile with no country recorded is unknown, not a no.
 assert.equal(resolveField(yesNo('Do you currently reside in the United States?'),withDefaults({...BASE,country:'',workAuthorization:'us-citizen'}),CONTEXT).outcome,'blocked');
});

/* ------------------------------------------------- knowing somebody here */

test('"do you know anyone who works at X" is denied rather than parked',()=>{
 const resolved=resolveField(yesNo('Do you know anyone who works at Smartsheet?'),CITIZEN,{...CONTEXT,company:'Smartsheet'});
 assert.equal(resolved.outcome,'fill');
 assert.equal(resolved.rule,'judgement-default');
 assert.equal(resolved.value,'No');
 for(const label of [
  'Do you know anyone currently employed at Smartsheet?',
  'Do you have any connections at Smartsheet?',
  'Do you have any personal contacts within the company?',
  'Do you have friends or family who work at Smartsheet?',
  'Were you referred by a current employee?',
 ]) assert.equal(resolveField(yesNo(label),CITIZEN,CONTEXT).value,'No',label);
});

test('the channel question is a different question and keeps its own answer',()=>{
 const menu={...ask('How did you hear about this role?'),type:'select',options:[{label:'Company website',value:'1'},{label:'LinkedIn',value:'2'}]};
 const resolved=resolveField(menu,CITIZEN,CONTEXT);
 assert.equal(resolved.rule,'how-heard');
 assert.equal(resolved.candidates[0],'Company website');
});

test('asked as prose, who you know is left to a person rather than answered "No"',()=>{
 const essay={...ask('If you know anyone who works at Smartsheet, please tell us who and how you know them.'),tag:'textarea',type:'textarea'};
 assert.notEqual(resolveField(essay,CITIZEN,CONTEXT).outcome,'fill');
});

/* ------------------------------ the refusals none of this is allowed to touch */

test('a question the profile genuinely cannot support still stops the application',()=>{
 for(const label of [
  'Do you currently hold an active Top Secret security clearance?',
  'Do you currently hold or have you previously held any securities industry licenses?',
 ]){
  const resolved=resolveField(yesNo(label),CITIZEN,CONTEXT);
  assert.equal(resolved.outcome,'blocked',label);
  assert.notEqual(resolved.rule,'judgement-default',label);
 }
 // A conviction question now answers, but only from the applicant's own
 // standing statement - never from a judgement default, and never with
 // that statement cleared. Both halves matter: the first is what keeps
 // the model out of a regulated denial, the second is what the applicant
 // changes when the answer is not No.
 const conviction=yesNo('Have you ever been convicted of a felony?');
 const answered=resolveField(conviction,CITIZEN,CONTEXT);
 assert.equal(answered.outcome,'fill');
 assert.equal(answered.rule,'criminal-record');
 assert.equal(answered.value,'No');
 assert.equal(resolveField(conviction,{...CITIZEN,criminalRecord:''},CONTEXT).outcome,'blocked');
});

test('an ordinary yes/no nothing names is still asked, not denied by default',()=>{
 // The denial list only reaches the questions written into it. A default
 // that spread to every two-button control would be guessing with a
 // straight face, which is the failure this whole file exists to prevent.
 const resolved=resolveField(yesNo('Have you completed our online coding assessment?'),CITIZEN,CONTEXT);
 assert.equal(resolved.outcome,'ask');
 assert.equal(resolved.rule,undefined);
});

/* ----------------------------------------- the applicant's own answers */

test('the bank keeps only the lines the matcher will actually use',()=>{
 assert.deepEqual(standingAnswers('security clearance = No\n\nnonsense\nab = c\n  Top Secret  =  Never held one  '),
  [{phrase:'security clearance',answer:'No'},{phrase:'top secret',answer:'Never held one'}]);
 assert.deepEqual(standingAnswers(''),[]);
 assert.deepEqual(standingAnswers(undefined),[]);
});

test('a stated answer still overrides the question this change just taught the bot to answer',()=>{
 // The escape hatch has to outrank the new rule as well, or the next
 // phrasing nobody predicted has nowhere to go.
 const stated={...CITIZEN,answerBank:'able to work in the us = No'};
 assert.equal(resolveField(yesNo(BETTERHELP),stated,CONTEXT).rule,'answer-bank');
 assert.equal(resolveField(yesNo(BETTERHELP),stated,CONTEXT).value,'No');
});

test('the settings page offers the bank, so stating one does not mean editing a file',()=>{
 const html=profilePage({profile:{...CITIZEN,answerBank:'security clearance = No\nTop Secret = Never held one'}});
 assert.match(html,/data-key="answerBank"/);
 assert.match(html,/data-key="licenses"/);
 assert.match(html,/Standing answers · 2 saved/);
 assert.match(profilePage({profile:CITIZEN}),/Standing answers · none yet/);
});

console.log(`${count} standing-answer checks passed.`);
