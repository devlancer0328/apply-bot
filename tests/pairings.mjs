import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {classifyPairingFolder,pairingFolders,pairingLink,parsePairedLines,reviewPairings,suppliedApplication} from '../src/pairings.js';
let count=0;const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};

/** The layout the applicant already keeps: employer, role, the saved link and the resume written for it. */
const CORPUS=[
 'Daniel/DataCamp/Principal AI Engineer - AI Tutor/job-link.txt',
 'Daniel/DataCamp/Principal AI Engineer - AI Tutor/job-description.txt',
 'Daniel/DataCamp/Principal AI Engineer - AI Tutor/Resume.pdf',
 'Daniel/DataCamp/Principal AI Engineer - AI Tutor/Resume.docx',
 'Daniel/DataCamp/Principal AI Engineer - AI Tutor/resume.json',
 'Daniel/Ascend Learning/Sr Data & AI Scientist/job-link.txt',
 'Daniel/Ascend Learning/Sr Data & AI Scientist/Resume.pdf',
];
const CANDIDATE={name:'Daniel Torres',email:'daniel@example.com',phone:'+1 (929) 489-1252',location:'Temple, TX',links:[]};
const DOCUMENT={name:'Daniel Torres',targetTitle:'Principal AI Engineer',contact:{email:'daniel@example.com'},sections:[
 {heading:'Professional Summary',paragraphs:['Nine years of adaptive learning and LLM tutoring work.']},
 {heading:'Core Skills',lines:[{label:'Programming Languages',text:'Python, SQL, TypeScript'}]},
 {heading:'Professional Experience',roles:[{company:'Scale AI',role:'Staff AI Engineer',startDate:'2021',endDate:'Present',bullets:['Shipped a tutoring agent.']}]},
]};
const pdf=text=>new Blob([text],{type:'application/pdf'});
const savedResume=(extra={})=>({id:'r-datacamp',name:'DataCamp · Principal AI Engineer - AI Tutor',kind:'supplied',fileName:'Resume.pdf',pdf:pdf('%PDF-1.4 datacamp'),sourceText:'Daniel Torres\nStaff AI Engineer, Scale AI',document:DOCUMENT,...extra});
const pairedJob=(extra={})=>({id:'https://job-boards.greenhouse.io/embed/job_app?for=datacamp&token=7619320',sourceUrl:'https://job-boards.greenhouse.io/embed/job_app?for=datacamp&token=7619320',applyUrl:'https://job-boards.greenhouse.io/embed/job_app?for=datacamp&token=7619320',company:'DataCamp',title:'Principal AI Engineer - AI Tutor',jd:'x'.repeat(900),resumeId:'r-datacamp',resumeLocked:true,...extra});

await test('An employer/role folder yields the link file, the resume PDF and the structured copy beside it',()=>{
 const folders=pairingFolders(CORPUS).map(classifyPairingFolder);
 assert.equal(folders.length,2);
 const datacamp=folders.find(f=>f.company==='DataCamp');
 assert.equal(datacamp.title,'Principal AI Engineer - AI Tutor');
 assert.equal(datacamp.fault,'');
 assert.match(datacamp.linkFile.name,/^job-link\.txt$/);
 assert.equal(datacamp.resumeFile.name,'Resume.pdf');
 assert.equal(datacamp.documentFile.name,'resume.json');
 assert.equal(classifyPairingFolder(pairingFolders(CORPUS)[1]).documentFile,null);
});

await test('A folder one level shallower still names its employer, and dotfiles are not mistaken for documents',()=>{
 const [flat]=pairingFolders(['Daniel/Tubi/job-link.txt','Daniel/Tubi/Resume.pdf','Daniel/Tubi/.DS_Store']).map(classifyPairingFolder);
 assert.equal(flat.company,'Tubi');assert.equal(flat.title,'');assert.equal(flat.fault,'');
 assert.equal(flat.files.length,2);
});

await test('A missing resume, a missing link and an ambiguous pile of PDFs are each refused with the reason',()=>{
 const faults=pairingFolders([
  'Daniel/Ondo/Senior Blockchain Engineer/job-link.txt',
  'Daniel/Helix/Staff Software Engineer/Resume.pdf',
  'Daniel/MCG/Staff Machine Learning Engineer/job-link.txt',
  'Daniel/MCG/Staff Machine Learning Engineer/Offer letter.pdf',
  'Daniel/MCG/Staff Machine Learning Engineer/References.pdf',
 ]).map(classifyPairingFolder).map(f=>[f.company,f.fault]);
 assert.deepEqual(faults,[['Ondo','no resume PDF in this folder'],['Helix','no job-link.txt in this folder'],['MCG','2 PDFs in this folder and none is named like a resume']]);
});

await test('A pairing with no readable resume never reaches the queue, and says which folder is wrong',()=>{
 const review=reviewPairings([
  {folder:'Daniel/DataCamp/Principal AI Engineer - AI Tutor',company:'DataCamp',title:'Principal AI Engineer - AI Tutor',link:'https://job-boards.greenhouse.io/embed/job_app?for=datacamp&token=7619320',resumeId:'r-datacamp',resumeName:'DataCamp'},
  {folder:'Daniel/Ondo/Senior Blockchain Engineer',company:'Ondo',title:'Senior Blockchain Engineer',link:'https://jobs.ashbyhq.com/ondo/7d4a6a16-9f1b-4a7e-9f1c-5c2a7f0b1d23',resumeId:'',resumeName:'',fault:'no resume PDF in this folder'},
  {folder:'Daniel/Float/Senior Data Engineer',company:'Float',title:'Senior Data Engineer',link:'',resumeId:'r-float',resumeName:'Float'},
 ]);
 assert.deepEqual(review.queued.map(r=>r.company),['DataCamp']);
 assert.deepEqual(review.rejected.map(r=>[r.where,r.fault]),[
  ['Ondo · Senior Blockchain Engineer','no resume PDF in this folder'],
  ['Float · Senior Data Engineer','no usable job link was found'],
 ]);
});

await test('A posting already applied to is dropped at import by the same index the run uses',()=>{
 const applied=[{id:'external:1',kind:'external',company:'DataCamp',urls:['https://job-boards.greenhouse.io/datacamp/jobs/7619320']}];
 const records=[
  {company:'DataCamp',title:'Principal AI Engineer - AI Tutor',link:'https://job-boards.greenhouse.io/embed/job_app?for=datacamp&token=7619320',resumeId:'r-datacamp',resumeName:'DataCamp'},
  {company:'Tubi',title:'Senior Engineer',link:'https://boards.greenhouse.io/tubi/jobs/4001',resumeId:'r-tubi',resumeName:'Tubi'},
  {company:'Tubi',title:'Senior Engineer',link:'https://boards.greenhouse.io/tubi/jobs/4001?utm_source=newsletter',resumeId:'r-tubi',resumeName:'Tubi again'},
 ];
 const review=reviewPairings(records,{applied});
 assert.deepEqual(review.queued.map(r=>r.company),['Tubi']);
 assert.equal(review.duplicates.length,2);
 assert.match(review.duplicates[0].fault,/already applied: DataCamp/);
 assert.match(review.duplicates[1].fault,/appears earlier in this import/);
 assert.deepEqual(reviewPairings(records).queued.map(r=>r.company),['DataCamp','Tubi']);
});

await test('Two columns are read whatever separates them, and a line with no resume is a fault rather than a bare link',()=>{
 const rows=parsePairedLines('https://boards.greenhouse.io/tubi/jobs/4001 | Tubi senior\nhttps://jobs.lever.co/ondo/7d4a6a16-9f1b-4a7e-9f1c-5c2a7f0b1d23,Ondo blockchain\nhttps://boards.greenhouse.io/mcg/jobs/9\t MCG ML \nhttps://boards.greenhouse.io/float/jobs/7');
 assert.deepEqual(rows.map(r=>r.label),['Tubi senior','Ondo blockchain','MCG ML','']);
 assert.equal(rows[0].link,'https://boards.greenhouse.io/tubi/jobs/4001');
 assert.equal(reviewPairings(rows.map(r=>({...r,resumeId:r.label?'r-'+r.label:''}))).rejected[0].fault,'no resume is paired with this link');
});

await test('A job link saved in a text file is read the way imported history reads one',()=>{
 assert.equal(pairingLink('https://job-boards.greenhouse.io/embed/job_app?for=datacamp&token=7619320\n'),'https://job-boards.greenhouse.io/embed/job_app?for=datacamp&token=7619320');
 assert.equal(pairingLink('Applied 6 Nov. See https://boards.greenhouse.io/tubi/jobs/4001.'),'https://boards.greenhouse.io/tubi/jobs/4001');
 assert.equal(pairingLink('no link here'),'');
});

await test('The paired resume is the document uploaded, byte for byte and under its own name',()=>{
 const saved=savedResume(),application=suppliedApplication(pairedJob(),saved,CANDIDATE);
 assert.equal(application.resume,saved.pdf);
 assert.equal(application.resumeName,'Resume.pdf');
 assert.equal(application.aiMode.selected,'supplied');
 assert.equal(application.company,'DataCamp');
 assert.equal(application.applyUrl,pairedJob().applyUrl);
});

await test('The supplied resume answers the form: its career, not the profile and not a generated one',()=>{
 const application=suppliedApplication(pairedJob(),savedResume(),CANDIDATE);
 assert.equal(application.currentCompany,'Scale AI');
 assert.equal(application.currentRole,'Staff AI Engineer');
 assert.equal(application.resumeData.summary,'Nine years of adaptive learning and LLM tutoring work.');
 assert.deepEqual(application.resumeData.coreSkills,[{category:'Programming Languages',skills:['Python','SQL','TypeScript']}]);
 assert.match(application.resumeText,/Scale AI/);
 // Supporting material is still the form's business; the resume is not.
 assert.equal(application.letterText,'');
 assert.equal(application.compensation.status,'not-requested');
});

await test('A pairing with no PDF, no text or a deleted library record fails before a tab is opened',()=>{
 assert.throws(()=>suppliedApplication(pairedJob(),null,CANDIDATE),/no longer in the resume library/);
 assert.throws(()=>suppliedApplication(pairedJob(),savedResume({pdf:null,originalPdf:null}),CANDIDATE),/has no PDF to upload/);
 assert.throws(()=>suppliedApplication(pairedJob(),savedResume({sourceText:'   '}),CANDIDATE),/No text could be read/);
 // An imported PDF resume keeps its file under originalPdf; that is still the file to send.
 const imported=savedResume({pdf:null,originalPdf:pdf('%PDF-1.4 imported'),fileName:''});
 assert.equal(suppliedApplication(pairedJob(),imported,CANDIDATE).resume,imported.originalPdf);
 assert.equal(suppliedApplication(pairedJob(),imported,CANDIDATE).resumeName,'DataCamp_Principal_AI_Engineer_AI_Tutor.pdf');
});

await test('A resume with no structured copy still applies: the PDF goes up and its text answers the form',()=>{
 const application=suppliedApplication(pairedJob(),savedResume({document:null}),CANDIDATE);
 assert.equal(application.resumeData,null);
 assert.equal(application.currentCompany,'');
 assert.match(application.resumeText,/Daniel Torres/);
});

await test('The run prepares a locked job from its pairing and never reaches the writer for it',async()=>{
 const source=await readFile(new URL('../src/background.js',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('const prepareCandidate=async item=>{'),source.indexOf('const applyCandidate=async item=>{'));
 assert.ok(body.includes('if(job.resumeLocked){'),'preparation must branch on the lock before anything is generated');
 const locked=body.slice(body.indexOf('if(job.resumeLocked){'),body.indexOf('else if(saved?.pdf'));
 assert.ok(locked.includes('suppliedApplication(job,saved,candidateFrom(profile))'),'a locked job is built from its stored pairing');
 assert.ok(!locked.includes('writeWithPatience'),'a locked job must never call the writer');
 assert.ok(!locked.includes('documentSignature'),'a locked job has no generation to cache');
 assert.ok(body.indexOf('if(job.resumeLocked){')<body.indexOf('writeWithPatience'),'the lock is tested before the generating path');
 // The pairing has to survive extraction, or the lock is lost before preparation reads it.
 const extract=source.slice(source.indexOf('const extractCandidate=async entry=>{'),source.indexOf('const screenCandidate=async item=>{'));
 assert.ok(extract.includes('resumeLocked:Boolean(entry.resumeId)'),'the queue entry decides whether the job is locked');
 assert.ok(extract.includes("entry.resumeId||row?.resumeId||''"),'a resume chosen earlier is kept when the entry names none');
 // The loaded list is where the three input modes meet; a pairing must decorate it rather than queue beside it.
 assert.ok(source.includes('paired.get(canonicalUrl(link))'),'a paired link enters the run as one of the loaded links');
});

console.log(`${count} paired job link and resume checks passed.`);
