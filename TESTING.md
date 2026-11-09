# Verification — 4.8.3

Tested 2026-11-06–07 on Windows with Node.js 22.23.4, controlled Chromium, and the user's existing Chrome session.

The live 50-employer acceptance target has **not been achieved**. Controlled submissions below are local fixtures and do not count as real applications.

## Final throughput fixes (4.8.2)

The native outcome audit found five confirmed submissions, fifteen manual handoffs, one uncertain send and seventy-five skipped results since the original acceptance baseline. These are persisted outcome records, not a count of unique attempts. Earlier native samples had median document preparation of 199.9 seconds, separate letters of 75 seconds, compensation research of 129.3 seconds and screening of 81.2 seconds. These medians cover different sample sets and must not be added into a predicted application time.

In addition to the scheduling changes below, unsupported AI answers now stop after one batch response. Malformed batches receive one repair instead of separate requests for every field. ChatGPT error detection reads actual platform notices and excludes user prompts/sidebar text, avoiding false refreshes when job text mentions errors. Exhausted renderer failures retire the worker rather than reopening the same broken conversation. The refresh limit remains three.

The native Danaher application submitted successfully in approximately 73 seconds using a saved High resume; this excludes its earlier resume generation. Its original final PNG visibly says “You have successfully applied for this position. Thank you.” Workday's following optional account-creation form had hidden that receipt from the detector. The new detector requires the explicit success phrase, application receipt ID, absence of an active wizard, and a newly appearing receipt. The existing outcome was reconciled from its original screenshot without sending again; original records and the screenshot hash are retained locally.

The original Danaher answer log also exposed repeated radio option values (`on`). Its race line cannot independently establish what was submitted; `Answer audit.txt` explains this and retains the original log. The saved intended profile value was East Asian. Current fills/logs use checked option labels, normalize country suffixes, and verify demographic selections instead of trusting a nonempty field. Focused browser tests exercise both duplicate radio values and a dropdown that refuses to retain the requested identity.

Final build and all 410 code checks passed. The 39 main browser checks, 23 staged/recovery checks, nine throughput checks and task-mode browser check passed (72 browser checks total), with no uncaught extension-view errors. Discovery tests covered rejected first pages, empty recycled sections, later eligible jobs, one-pass exhaustion and exactly three refresh retries. The 4.8.1 controlled fifty-receipt test passed in 448.351 seconds with 51 High requests, no unnecessary salary requests, correct PDFs/PNGs and company protection. That fixture timing is not a live throughput estimate. The final changed failure/Workday paths have dedicated 4.8.2 regressions.

The idle native deployment preserved profile/history hashes and every record ID: 973 history entries, 160 results, 323 jobs and 26 resumes. Version 4.8.2 restarted the existing Chrome run with five confirmed submissions and 45 remaining; the saved preference remains 50. Auto-submit, exports, two sessions, company protection and the user's allow-unknown policy remain enabled. No real fifty-submission completion is claimed. Private evidence is in `test-results/v482-*.json` and `v482-*.txt`, excluded from release archives.

The user subsequently supplied the missing Vanderbilt relatives fact. It was saved as a company-specific answer instruction, with the previous pre-submit outcome preserved under `v482VanderbiltFactRelease`. No company marker existed. After a safe stop/restart, the native run reused Vanderbilt's High PDF while generating Air's resume in High in another owned tab. Vanderbilt recovered from one Workday server error and filled nine application-question fields; five open questions used one 30.9-second AI response. This checkpoint is progress evidence, not a final receipt.

## Throughput architecture and native recovery (4.8.1)

The old staged runner generated every selected document before applying any ready job. Preparation now keeps at most two jobs preparing/ready/applying in total, applies completed jobs in completion order, and leaves a ChatGPT slot available for the active form. Extraction/screening use small windows. Submission and final capture remain sequential. Queued jobs resume before more feed discovery; supported short forms and saved documents are prioritized.

High resume generation is separated from support work. Salary research starts only when an actual form asks about pay. Required letters are generated on demand; optional letter generation is a saved setting, off by default. Existing supplied letters and High PDFs are reused. Missing salary evidence still blocks required salary fields. Known missing candidate facts stop support requests before spending more AI calls. Unreadable originals receive a thirty-minute retry cooldown, bypassed by explicit Recheck. Cached employer/original-link hints and passively observed Jobright hints avoid unnecessary aggregator visits; copied descriptions are never used as originals.

Workers recover two-session capacity after four healthy requests following a fallback. Research, answers and separate letters use owned temporary tabs separated by task type; the user’s ChatGPT tab stays intact. Readiness checks use an owned probe when a context URL is configured. A verified current High selection does not require opening its picker. If an Instant/Medium picker is unresponsive, a verified allowed non-resume mode can be retained; High never downgrades. All pre-send mode and prompt identity checks remain active.

Manual outcomes record whether Submit was attempted. Only proven pre-submit failures can be rechecked without company suppression; imported history, durable submission markers, confirmed/uncertain sends and legacy manual outcomes remain protected. Recheck clears only posting retry exclusions and never clears submission history. The specific observed Vanderbilt failure on Application Questions was audited locally before being queued again: no Submit log or durable company marker existed. Its original result is preserved in SQLite under `v481PreSubmitRecovery`.

The 4.8.0 controlled fifty-receipt run took **402.202 seconds**, versus the earlier 4.7.0 fixture’s 620.759 seconds. It used 51 High requests and no compensation requests for forms without pay questions. These are fixture timings, not real ChatGPT/employer throughput. A separate controlled slow-peer test confirmed the ready job **10.646 seconds before** the slower resume completed. The native 4.8.0 follow-up exposed the shared-tab mode failure that the owned-tab and allowed-mode changes above address.

## Live status and profile matching (4.7.4)

At 02:17 JST on November 7, the existing Chrome run had three confirmed submissions (Stackpoint Studio, OPSWAT and Niche), ten application attempts, 39 screened jobs and 58 held jobs. The three successful folders contain actual PDFs, final screenshots and timing files. The saved Niche screenshot visibly confirms receipt. The run continued beyond the earlier one-or-two-job failure; 50 live submissions remain unverified.

The live Bjak form exposed a country question longer than the old 40-character label limit. Explicit residence questions now use the saved country in text and dropdown fields; missing country facts remain blocked, and residence cannot establish citizenship or authorization. Country is also included explicitly in AI candidate facts. Structured resume/research output mentioning fabrication or errors is no longer falsely classified as a refusal; genuine refusal/error responses remain rejected. Four focused regressions cover these changes.

Remaining live obstacles include employer CAPTCHA, missing verification emails, unsupported compensation evidence, Workday degree/relocation validation, and ChatGPT responses that contain analysis rather than a usable resume. These outcomes are not counted as submissions. Existing unknown-evidence permission is preserved; confirmed conflicts and company duplicate protection remain enforced.

Version 4.7.4 passed **389 code checks** and **39 main browser checks**, with no uncaught extension-view errors. The idle reload at **02:21:23 JST** preserved profile/history hashes and all IDs: 971 history records, 150 application records, 323 jobs and 17 resumes. The actual saved profile passes the country regression in the installed extension, and all three confirmed employers remain protected. The run restarted at **02:21:39 JST** with a limit of 47 further confirmed submissions; the saved preference remains 50. Auto-submit, file exports and unknown-evidence allowance remain enabled. Evidence: `v474-check.txt`, `v474-browser.txt`, `v474-loaded-verification.json`, `v474-live-preflight.json`, `v474-resume-run.json` and `v474-live-export-audit.json` in the private local `test-results/` directory. These reports contain live personal/job context and are excluded from release ZIPs.

## Labelled URL rendering and document recovery (4.7.3)

The live MCG application test generated its resume in High mode, then exposed an incorrectly rejected cover-letter prompt. ChatGPT's link renderer moved an array bracket into a URL inside a JSON object containing both a label and URL. Both initial prompt binding and refresh recovery now normalize that specific rendering. Full prompt identity remains required, and a different URL still fails verification. Two regressions exercise these actual in-page guards.

The job now reserves its document ID before generation, and saved documents carry the input signature. A later run can reuse the exact saved High-mode PDF when the signature matches. Changed inputs or missing High metadata force normal generation. Cover letters are saved before compensation research so a later failure retains them too. Three regressions exercise the actual application writer with new checkpoints after failure. All **385 code checks** passed.

The MCG High-mode resume took **165.579 seconds** in the first attempt and rendered as a readable two-page PDF. Version 4.7.3 preserved profile/history hashes and all record IDs across an idle reload at **22:49:52 JST**: 966 history records, 93 application records, 204 jobs and one saved resume. The retry reused that same PDF and completed its cover letter in **26.7 seconds**. This is live component evidence; it does not establish 50 employer submissions.

The user subsequently changed the unknown-evidence policy to **Allow**. Confirmed conflicts still reject jobs. A single-application test temporarily disables discovery and sets one-attempt/one-confirmed limits, then restores the prior run controls and links. The newly requested Allow policy remains saved.

## Late source evidence (4.7.2)

Live research exposed a second timing issue: native source badges can hydrate after the answer text stabilizes, especially when a hidden worker comes forward. The reader now waits up to three seconds for the current assistant turn's native citation controls and rereads that turn. It still requires native evidence plus independent source verification; ordinary model-written links do not become citations. Regressions cover delayed badges and delayed citation anchors outside the markdown, while preserving unrelated-dialog isolation.

Explicit wording such as a fully remote independent contractor opportunity is retained from the verified original. It proves the work arrangement only, without filling in travel, clearance or interview requirements. Screening caches refresh once for this correction. Research retains its native evidence for diagnostics, and the prompt requests concise findings without extra eligibility sections; research scope and strict unknown handling are unchanged. All **380 code checks** and all **39 main browser checks** passed for 4.7.2, with no uncaught JavaScript errors. The 4.7.1 staged suite also passed all 23 checks, including continuous discovery, fallback, actual refresh limits and final-page capture.

The existing Chrome extension was reloaded to 4.7.2 at **22:20:25 JST**. Profile/history hashes and all record IDs matched: 966 history records, 93 application records, 204 jobs and no saved resumes. The original acceptance baseline, strict rules, auto-submit and file exports were preserved on restart. The preceding 4.7.1 run completed six live research replies without a worker failure before being stopped for this update; it produced no application attempts.

## Loading-worker recovery (4.7.1)

The live 4.7.0 run stopped after a research worker stayed on a loading placeholder. That was incorrectly classified as a login failure even though the other worker completed a response. Version 4.7.1 distinguishes a visible login control from a missing editor, brings the main tab forward for readiness, and waits up to 20 seconds for an enabled Send button. It never uses synthetic Enter to claim that a disabled composer sent a request. Explicit usage-limit notices remain account errors.

After exactly three unsuccessful refreshes, an owned renderer with a loading/send/response failure is retired. The failed job stays held, while a later job can use a new worker tab. This does not add a retry to that failed job or bypass account limits. The new transport regression exercises the actual worker manager: four failed probes, three refreshes, retirement of the owned tab, a successful next job, and no change to the user's conversation. All **377 code checks** passed, including 16 mode/editor checks and 22 source/recovery checks.

The idle extension was reloaded to 4.7.1 at **22:06:58 JST**, with matching profile/history hashes and unchanged IDs: 966 history records, 79 application records, 179 jobs and no saved resumes. The real run restarted at **22:07:04 JST**, preserving the original 50-submission baseline, strict rules, automatic submission and file exports. At restart there were **0 confirmed real submissions**. The controlled 50-submission result below belongs to 4.7.0 and does not establish live acceptance for 4.7.1.

## Parallel research and receipt checks (4.7.0)

The staged pipeline now screens up to two jobs at once with the existing two-worker setting. Web research uses isolated temporary conversations; resumes retain their project context and High mode. Browser interactions remain serialized, and forms/screenshots run one at a time. Input order and job identity survive out-of-order replies. Stop and fatal account/mode errors drain active requests before finishing; queued tasks do not continue. Standalone resume contexts and the one-session setting retain sequential behavior.

Workday now requires a new receipt after Submit. Moving away from review, an unknown page, a loading page or congratulatory posting text cannot count as submitted. A receipt found before this run pressed Submit becomes an uncertain existing application with company protection, rather than a new success. Six regressions exercise both the DOM reader and the actual background driver with controlled page states.

All **373 code checks** and **68 browser checks** passed: 39 main, 23 staged, 5 controlled acceptance and 1 mode-transport check. The staged test proves that two research conversations overlap, finish out of order and leave the main project conversation untouched. It also checks fallback, recovery, source exhaustion and screenshots. An unavailable required mode stops queued work instead of making every remaining job fail or permitting a lower resume mode.

The repeated 50-submission controlled test passed in **620.759 seconds (10 minutes 21 seconds)**. It confirmed exactly 50 distinct employers after 51 attempts, rejected the initial uncertain outcome from the success count, never submitted job 52, validated all PDFs and PNGs, verified High/Medium modes and timing boundaries, and blocked a later duplicate. This is a local fixture duration, not a prediction of real employer/model performance. Current evidence: `v470-check-final.txt`, `v470-browser.txt`, `v470-staged.txt`, `mode-browser-report.json` and `fifty-browser-report.json` under `test-results/`.

## Mode follow-up (4.6.2)

Form-answer requests now explicitly prefer Instant; research and cover letters prefer Medium; resumes still require High. Non-resume tasks can fall back between Instant and Medium. The selector and pre-send guard recognize the same thinking/reasoning effort control variants and ignore unrelated model headers. Modes are normalized consistently, including the Instant `none` alias, and rechecked while waiting for Send and immediately before clicking Send.

All 12 focused mode/rich-editor checks pass, including single and batch form-answer routing, late mode changes and alternate effort controls. The mode browser test exercises the actual transport against a controlled ChatGPT page through High → Instant → Medium → Medium → High and checks the mode at every Send plus unchanged resume prompts. After sign-in was restored, five fresh-page native selector checks completed in **84.667 seconds**: High, Instant, Medium (allowed Instant fallback), High and Medium. No prompts were sent during this selector diagnostic. Evidence: `v462-native-mode-resumed.json`. The earlier four native checks and the 50 controlled submissions below were recorded for 4.6.1; they are not new live acceptance results for 4.6.2.

Version 4.6.2 passed all 363 code checks, the main browser checks and the dedicated mode browser check. The main suite now passes **39 checks**, including a new regression where an imported brand and its verified legal-employer alias are blocked by both the pipeline and the atomic submission guard, without an AI request or a new claim. Reports: `v462-check.txt`, `verified-alias-browser.txt` and `mode-browser-report.json`.

The live acceptance run resumed at **20:56:15 JST on 2026-11-06**, preserving the original acceptance baseline, strict rules, company history, automatic submission and file exports. Its confirmed target remains 50; the prior sign-out run described below is historical, not the resumed run's current status.

The restored account also passed a read-only access check for the saved Daniel project. During the live run, two imported employer-name variants needed verified aliases; the run was stopped safely, the existing history entries were updated with primary-source verification, and the real submission guard was confirmed to reject the duplicate. All 966 history IDs/counts and the confirmed-submission count were preserved. The run resumed at **21:11:48 JST** with the same target and restrictions. The private alias audit is excluded from release archives; this is a local history correction, not a new fuzzy company-name rule.

## Retained changes and earlier acceptance (4.6.1)

- Resume requests require native **High**; other AI tasks use **Medium**. Selection is verified before sending, including fresh-page hydration and refresh recovery. Resume prompts still contain only the complete job description.
- Inline URL icon CSS is excluded from composer and posted-message comparisons. The exact live prompt that previously failed was reproduced without sending, and its full text now matches.
- A confirmed-submission target counts employer receipts separately from attempts. Receipt text already present before Submit and a confirmation-like URL alone cannot establish success. Uncertain submissions retain company protection.
- Workflow and application durations use a monotonic clock. `Timing.json` exports UTC timestamps, timezone and measured durations beside the resume and final screenshot.
- Required candidate questions without supported facts stop for review. AI cannot substitute invented answers, N/A, decline or the first option.
- Verified original posting URLs remain valid evidence when the application URL differs. ATS workplace metadata is retained separately from geographic location. Old extraction caches refresh once after this upgrade.

The earlier 4.6.1 controlled acceptance test passed **50 server-confirmed fixture submissions in 677.939 seconds (11 minutes 18 seconds)**. The first attempt intentionally produced no new receipt and did not count. The next 50 confirmed, and job 52 was never attempted. All 50 employers were unique; uploaded PDFs, candidate/employer identity, final PNG screenshots, timing boundaries and AI modes passed inspection. A later run could not reapply to those companies. The archived report is `fifty-browser-v461-report.json`. These timings measure local fixtures, not real ChatGPT or employer performance.

In the existing Chrome session, the native mode selector passed four fresh navigations: High → Medium → High → Medium. The live run was configured with automatic submission, file exports and a target of 50. Saved restrictions remain strict: remote, no required travel, no security clearance and no on-site interview; unknown requirements are held. The latest run stopped safely after **224 seconds**, with **0 confirmed submissions**, when ChatGPT signed out and all three refresh retries failed. The live page showed Log in, and a read-only session check returned no signed-in user. An earlier run screened eight roles without transport errors; all remained held under the saved rules. A live auditor separately checks receipts, PDF identity/readability, High mode metadata, matching archived PDFs, actual PNG dimensions, durations and completed Chrome downloads for new confirmed applications. It has no real submissions to validate yet.

Current local evidence includes `fifty-browser-report.json`, `native-mode-qa.json`, `composer-reproduction.json`, `acceptance-current-check.txt` and `fifty-live-progress.json` under `test-results/`. Personal settings, browser profiles, databases and these reports are excluded from release archives.

## Retained discovery fix

The previous collector jumped to the bottom and could mistake repeated visible cards for an exhausted feed. Jobright recycles mounted cards and loads additional pages during scrolling. The reference Jobright extension was inspected as source only; its desktop integration and automatic “Already Applied” marking were not installed or copied.

The replacement scans overlapping viewports in the actual job-list container, retains discovered links, and resumes at its cursor across bounded reads. A read budget is never an end-of-feed signal. Completion requires a stable bottom, no visible loader or pending job-list request, and repeated quiet confirmations. Job-list responses are observed passively; telemetry is ignored. The live `position`/`count` pagination parameters keep the same feed identity. Filter changes invalidate the previous identity, and stale responses cannot override it.

Discovery counts new links across a complete pass, including earlier chunks. One-pass mode also reads the entire feed. A loader or repeated responses without new cards eventually produce an actionable error rather than false exhaustion or indefinite waiting. The monitor displays unique links, progress through the currently loaded list, and completion/waiting status.

## Automated checks

- **385 code checks**, including concurrent research, required-mode failures, Workday receipt proof, timing, candidate-answer safety and original/application URL matching, plus the 16 discovery regressions.
- Latest completed browser runs: **39 main checks on 4.7.2**, **23 staged and 1 mode check on 4.7.1**, with no uncaught JavaScript errors. The **5 controlled 50-submission acceptance checks** retained below ran on 4.7.0; they are not real employer submissions.
- The full staged Jobright workflow uses a recycled list with long empty sections. It rejects the first role, reaches two distant eligible employers, fills both forms, saves their last-page screenshots, then confirms a complete pass without new jobs. One-pass mode separately reaches both distant roles before stopping.
- The Hiring Cafe workflow also completes another full pagination cycle after discovering new jobs; an empty final page alone cannot erase earlier discoveries.
- Existing coverage retains optional screening, original employer descriptions, overlapping ChatGPT requests, compensation citations, profile answers, attachments, SQLite backup/restore, company protection, recovery limits, screenshots and restart persistence. Automatic submission is exercised only against a local fixture.

## Previous release's read-only Chrome checks

The corrected reader collected **616 distinct links over 30 bounded reads in 262.7 seconds**, with monotonically increasing counts. The feed continued loading, so the read-only diagnostic was deliberately stopped; it correctly still reported more jobs. This was not a live feed-exhaustion test.

The installed extension was reloaded to **4.5.1** while idle. Its final reader then resumed the same live feed and reached **620 links**. The saved profile hash and job, resume, application and company-history IDs/counts were unchanged across reload: **966 history records, 31 application records, 94 jobs and 0 saved resumes**. Auto-submit, file export, automatic fetching, continued discovery and the five-attempt limit were preserved.

These checks scroll/read the existing Jobright tab and do not send employer applications or mark jobs applied. The controlled workflow establishes end-of-feed and screenshot behavior; it does not establish successful submission on every live employer form.

## Reproduce

```sh
npm ci
npm run build
npm run check
npx playwright install chromium --no-shell
npm run test:browser
npm run test:staged
npm run test:acceptance
npm run test:modes
```

The browser tests write their Chrome profiles, downloads and generated certificates to `~/.cache/apply-bot-scratch`, outside the extension directory: Chrome loads that directory unpacked and scans every byte of it, so a test profile left inside it is handed to Chrome on every load. Set `APPLY_BOT_SCRATCH` to put them somewhere else. A passing run deletes its own profile; a failing one leaves it behind, because it is the state that produced the failure.

Local evidence is in `test-results/`, including `jobright-live-final-scan.json`, `jobright-live-reloaded-reader.json`, `jobright-staged-run.json`, `jobright-discovery-monitor.png` and the browser reports. Personal settings, test profiles and local reports are excluded from the release ZIP. The archive is checked against source hashes; an extracted copy is independently installed, built and checked.

## Limits

The saved application-attempt limit still ends a run sooner; set it to **0** for unlimited attempts. A confirmed target never relaxes filters or bypasses company protection. Optional filters can hold every listing when required evidence is missing. Live research cannot guarantee unpublished requirements. Employer forms may require login, CAPTCHA or candidate answers, and Lever's final submission remains manual. Fifty local fixture successes do not establish fifty real employer submissions.
