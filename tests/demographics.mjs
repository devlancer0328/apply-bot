import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {resolveField,resolveForm} from '../src/answers.js';
import {demographicWordings,isDemographicQuestion} from '../src/demographics.js';
import {withDefaults} from '../src/profile.js';

let count=0;
const test=async(name,work)=>{await work();console.log(`PASS ${name}`);count++;};
const profile=withDefaults({gender:'Male',pronouns:'He/him/his',race:'East Asian',hispanic:'no',veteran:'No Veteran',disability:'No',sexualOrientation:'Straight',transgender:'no'});
const field=(label,labels=[],required=false)=>({key:label,label,type:'select',required,options:labels.map((label,i)=>({label,value:String(i+1)}))});
await test('CC-305 checkbox choices match the saved disability status and never substitute a decline or an absent fact',()=>{
 const f={...field('Disability: Please check one of the boxes below:',['Yes, I have a disability, or have had one in the past','No, I do not have a disability and have not had one in the past','I do not want to answer'],true),name:'disabilityStatus',type:'checkboxgroup'};
 assert.deepEqual(resolveField(f,{disability:'No'},{}).candidates,[f.options[1].label]);
 assert.deepEqual(resolveField(f,{disability:'Yes'},{}).candidates,[f.options[0].label]);
 assert.deepEqual(resolveField(f,{disability:'Decline'},{}).candidates,[f.options[2].label]);
 assert.equal(resolveField(f,{},{}).outcome,'blocked');
});
await test('CC-305 display language and optional internal employee ID do not request candidate facts from AI',()=>{
 const language={...field('Language',[],true),name:'disabilityForm',current:'English',purpose:'display-language'};
 assert.equal(resolveField(language,{disability:'No'},{}).outcome,'skip');
 assert.deepEqual(resolveField({...language,current:'Select One'},{disability:'No'},{}).candidates,['English']);
 assert.equal(resolveField({label:'Employee ID (if applicable)',type:'text'},profile,{}).outcome,'skip');
 assert.equal(resolveField({label:'Employee ID',type:'text',required:true},profile,{}).outcome,'blocked');
});
await test('Gender, orientation, veteran and race use saved facts across the live form wordings',()=>{
 for(const [label,choices,expected] of [
  ['Gender',['Male','Female','Decline To Self Identify'],'Male'],
  ['How would you describe your gender identity?',['Man','Non-binary','Woman',"I don't wish to answer"],'Man'],
  ['How would you describe your sexual orientation?',['Asexual','Gay','Heterosexual',"I don't wish to answer"],'Heterosexual'],
  ['Are you a veteran or active member of the United States Armed Forces?',['Yes, I am a veteran or active member','No, I am not a veteran or active member',"I don't wish to answer"],'No, I am not a veteran or active member'],
  ['Veteran Status',['I am not a protected veteran','I identify as one or more of the classifications of a protected veteran',"I don't wish to answer"],'I am not a protected veteran'],
  ['Please identify your race',['White','Black or African American','Asian','Decline to self-identify'],'Asian'],
  ['How would you describe your racial/ethnic background?',['East Asian','South Asian',"I don't wish to answer"],'East Asian'],
 ]){
  const result=resolveField(field(label,choices),profile,{});assert.equal(result.outcome,'fill',label);assert.deepEqual(result.candidates,[expected],label);
 }
});
await test('Broader demographic categories never narrow or change saved identity',()=>{
 assert.equal(resolveField(field('Race',['East Asian','South Asian',"I don't wish to answer"]),{...profile,race:'Asian'},{}).outcome,'skip');
 assert.equal(resolveField(field('Gender',['Man','Woman',"I don't wish to answer"]),{...profile,gender:'Non-binary'},{}).outcome,'skip');
 assert.equal(resolveField(field('Veteran Status',['I identify as one or more of the classifications of a protected veteran',"I don't wish to answer"]),profile,{}).outcome,'skip');
 assert.equal(resolveField(field('Are you a veteran?',['Yes, I am a veteran','No, I am not a veteran']),{...profile,veteran:'I am not a protected veteran'},{}).outcome,'skip');
});
await test('Decline choices are selected only for an explicit saved decline',()=>{
 for(const [key,label] of [['gender','Gender'],['race','Race'],['veteran','Veteran Status'],['sexualOrientation','Sexual orientation']]) {
  const labels=['Some other answer',"I don't wish to answer"];
  const selected=resolveField(field(label,labels),{...profile,[key]:'Prefer not to say'},{});
  assert.equal(selected.value,'2');
  const unmatched=resolveField(field(label,labels),profile,{});assert.equal(unmatched.outcome,'skip');
 }
});
await test('Pronouns stay separate from gender, including old saved pronoun values',()=>{
 assert.equal(resolveField(field('Pronouns'),profile,{}).value,'He/him/his');
 const legacy={...profile,gender:'He/him/his',pronouns:''};
 assert.equal(resolveField(field('Gender',['Man','Woman'],true),legacy,{}).outcome,'blocked');
 assert.equal(resolveField(field('Pronouns'),legacy,{}).value,'He/him/his');
 assert.deepEqual(demographicWordings('gender','They/them'),[]);
});
await test('Profile-owned dropdown fills explicitly replace stale selections',()=>{
 const planned=resolveForm([field('Gender'),field('Sexual orientation'),field('Veteran Status'),field('Race')],profile,{});
 assert.equal(planned.fills.length,4);assert.ok(planned.fills.every(fill=>fill.replace));assert.equal(planned.questions.length,0);
});
const background=await readFile(new URL('../src/background.js',import.meta.url),'utf8');
const start=background.indexOf('async function rescue(');
const rescueSource=background.slice(start,background.indexOf('\n/**',start));
await test('Dropdown rescue maps demographics locally and never asks AI for a replacement',async()=>{
 let calls=0;const applied=[];
 const menus={'Gender':['Man','Woman',"I don't wish to answer"],'Sexual orientation':['Heterosexual',"I don't wish to answer"],'Veteran Status':['I am not a protected veteran',"I don't wish to answer"],'Race':['Asian',"I don't wish to answer"]};
 const rescue=vm.runInNewContext(`(${rescueSource})`,{resolveField,isDemographicQuestion,isCompensationQuestion:()=>false,
  inFrame:async(_tab,_frame,_fn,args)=>{if(typeof args[0]==='string')return menus[args[0]];applied.push(...args[0].fills);return {applied:args[0].fills.map(f=>f.key),failed:[]};},
  answerAll:async()=>{calls++;throw new Error('Demographics reached AI');},menuShapeAnswer:()=>{throw new Error('Demographics reached menu guessing');}
 });
 const fields=Object.keys(menus).map(label=>field(label));
 const result=await rescue(1,0,fields,{},profile);assert.equal(calls,0);assert.equal(result.failed.length,0);assert.equal(applied.length,4);assert.ok(applied.every(f=>f.replace));
 menus.Gender=['Woman',"I don't wish to answer"];
 const missing=await rescue(1,0,[field('Gender')],{},profile);assert.equal(missing.failed.length,1);assert.equal(missing.applied.length,0);assert.equal(calls,0);
});
console.log(`${count} demographic regression checks passed.`);
