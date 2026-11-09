# Apply Bot 4.8.3

Chrome extension for finding jobs, researching optional requirements, creating tailored PDFs through your ChatGPT project, and filling applications. Templates, resumes, evidence and application history live in local SQLite.

## Install or update

1. Extract the release ZIP.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked → apply-bot**.
3. To update, replace the files in your existing extension folder and click **Reload**. Keep the existing extension installed to preserve its data.
4. Click the toolbar icon. The workspace opens in Chrome's side panel beside the page you are on; **Full tab ↗** in its header reopens the view you are looking at as a full tab, which the resume editor and template studio need. **Options** in the extension's right-click menu opens the same tab directly. If a version mismatch or **Unknown database table** is reported, use the **Reload extension** action when no run is active.

## Set up

- **ChatGPT:** add your real career details and resume instructions to a ChatGPT project. Sign in and save its URL in **Settings**. Resume generation sends **only the complete job description**. A standalone conversation also works, sequentially.
- **My profile:** save contact details, actual earliest start date and standard application answers. Gender and pronouns are separate. Unmatched demographic answers are flagged instead of guessed.
- **Template studio:** edit fonts, colors, spacing, margins and sections, preview the PDF, then choose **Use template**.
- **Job sources:** paste links or add a public Google Sheet, then **Load links**. For discovery, enable **Collect jobs from feeds**, select **Jobright recommendations** or enter a Hiring Cafe search URL, and **Save changes**.
- **Already applied:** import your previous companies before running. Paste names or select the parent folder containing `Company / Role / job-link.txt`. Review and confirm the preview; resume contents are not read.
- **Connections:** keep ChatGPT signed in. Open Gmail when verification is needed. Workday also needs your address and account password in Settings.

Tabs can be in any order; services are detected by URL. If Run is disabled, follow the setup links shown on **Overview**.

**One application per company is always enforced**, across roles and boards. Name matching normalizes punctuation, spacing and common legal endings. Add aliases for alternate brands. Imported entries with unknown employers must be resolved before running.

## Optional job filters

Open **Workspace → Jobs & filters**. Filters start **off** and every restriction can be left at **Any**. Profile preferences do not automatically enable restrictions.

Available rules include remote/hybrid/on-site work, required travel, clearance, on-site interviews, location eligibility, employment type, sponsorship, relocation, on-call work, title phrases, excluded employers and additional written requirements.

For enabled research rules, ChatGPT Search checks the exact role and employer, the posting and relevant company policies. The extension verifies cited source URLs and quoted excerpts. Missing evidence stays **unknown**. The default is **Hold for review**; it never assumes that an omitted requirement means No. Public information cannot guarantee perfect accuracy.

**Jobs → Evidence** shows decisions, excerpts and links. Use **Recheck requirements** for fresh extraction/research or **Keep on hold** to pause a job. **Resume eligible jobs** adds pending eligible jobs to the queue; start Run to continue.

## Run and review

The workflow uses small windows: **Discover → Extract → Research/filter → Select one role per company → Prepare resume → Apply → Screenshot**. A ready application starts while the next resume is generating. Forms and screenshots stay sequential. Pending jobs and unchanged documents are reused after a restart. Jobright supplies links and employer hints; descriptions are verified against the original posting. Unreadable originals wait 30 minutes before automatic retry; **Recheck requirements** retries immediately.

Salary research starts when a form asks for compensation. Required cover letters are generated when requested; letters returned with the resume are reused. **Settings → Documents and speed → Generate optional cover letters** enables extra letter requests; it is off by default. No pay question means no salary request. No static salary fallback is used.

- **Settings → ChatGPT sessions:** choose two sessions or one. Research, form answers and separate cover letters use extension-owned temporary tabs; resumes use your saved project. Tabs are separated by task type. Standalone resume conversations stay sequential. Repeated tab failures reduce concurrency to one; four healthy requests restore two. Account limits or an unavailable required mode stop the run.
- **AI modes:** resumes require **High**. Form answers prefer **Instant**; web research and cover letters prefer **Medium**. Other AI tasks can fall back between Instant and Medium when needed. The extension verifies the mode immediately before sending; resumes never fall back below High, and their messages still contain only the job description.
- **Workspace → Run monitor:** see the current stage, worker tasks, response progress, elapsed time, recent job activity, errors and the exact stop reason. The status and log survive extension reload and browser restart. Download the run log for troubleshooting. A waiting notice appears after a minute without visible progress; ChatGPT replies have a six-minute deadline.
- **Run until no new jobs:** in **Job sources**, enable **Collect jobs from feeds** and **Continue until no new jobs**, then enable the desired feeds. In **Settings**, set **Application attempts per run** to **0**. Otherwise that limit ends the run sooner. Rejected, held, duplicate and unsupported jobs do not consume attempts or stop discovery of later pages. Jobright scans the list one viewport at a time, remembers cards removed by scrolling, and confirms a quiet bottom before reporting completion. The monitor shows scan progress. A read that reaches its time budget continues in the next batch. A full round without new job links finishes the run; three consecutive source failures stop with an error.

**Review before sending** is on by default: filled forms stay open before final submission. Turn it off in Settings for automatic submission. Stop takes effect between operations.

**Settings → Confirmed submissions per run** sets a success target; **0** disables it. For a target such as 50, turn off review mode and set the attempt limit to **0**. Only confirmed employer receipts count. Held jobs, uncertain submissions and attempts do not count; filters and company protection still apply.

Every application attempt saves **Last page.png** before its tab closes. Open **Applications → Details** to see the image and download **Last page screenshot (PNG)**. Review mode also captures the page and leaves it open. Capture/storage failure keeps the tab open. Optional file exports save another copy in Downloads.

Enable file exports in Settings for downloaded copies. Chrome's configured Downloads folder receives the application folder with its resume, **Last page.png** and **Timing.json**. Applications → Details shows the folder and measured durations, including waiting. If every job is held before a form opens, there are no application screenshots yet.

After submitting a review-mode form yourself, choose **Applications → Details → I completed this application**. Automatic submission saves a durable company marker before pressing Submit; interrupted or uncertain submissions stay blocked until checked.

For a failure recorded **before Submit**, correct the issue and choose **Jobs → Evidence → Recheck requirements**. Saved High PDFs can be reused. Confirmed, uncertain and legacy outcomes without proof of a pre-submit failure remain protected.

**My resumes** manages generated outputs: edit, duplicate, import, search and export documents. These library documents are not inputs to new generation.

Greenhouse, Ashby, Workday, Rippling, Workable and ApplyToJob have handlers. Lever needs manual final submission. Unsupported sites are listed in Jobs; optional manual preparation can create their documents.

Jobright and Hiring Cafe supply links only. Descriptions come from the original employer posting through its official ATS data or rendered page. Unreadable originals are held for review; aggregator text is never substituted. **Jobs → Details** shows the description source. Explicit requirements in that original are checked first; web research covers unanswered enabled criteria.

ChatGPT page/session failures trigger up to **3 refresh retries** per request. The monitor shows each retry. A completed reply is recovered before another prompt is sent. Loading pages and disabled Send buttons are worker errors; an owned tab that stays broken is closed after its retry budget, and later jobs continue in a fresh tab. Persistent login/usage errors stop with a visible explanation; unrelated conversations are never reused. Application submissions are not retried by this mechanism.

## Compensation

ChatGPT Search researches the company and exact role, using this prompt:

```text
Based on JD and company, tell me what compensation this position would be.
Must be consider exact salary range of that kind of roles in the company.
```

There are no configured salary ranges or default amounts. Native citations and matching company/role evidence are required. A required salary field without usable research is held for manual review. Research and source links are saved with the documents and application.

## Back up and build

**Settings → Export SQLite backup** saves the full database; Restore replaces it. Back up before removing the extension or clearing browser data. Backups contain personal data and saved credentials. Downloads are optional copies; SQLite is the database.

Requires Node.js 22.13 or later:

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

Load the project folder containing `manifest.json` after building. See [TESTING.md](TESTING.md) for verification and limits.
