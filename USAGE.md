# Apply Bot — how to use it

An unpacked Chrome extension that finds job postings, writes a tailored resume for
each one with ChatGPT, fills the application form, and submits it. It drives your
own signed-in browser, so it applies as you, from your machine. Nothing is sent to
a server of ours, because there isn't one: everything lives in a SQLite database
inside the extension.

It currently fills forms on **Greenhouse, Ashby, Lever, Workday, Rippling,
Workable and ApplyToJob**.

---

## Contents

- [Install](#install)
- [First run in ten minutes](#first-run-in-ten-minutes)
- [The pages](#the-pages)
- [Starting, stopping, and the unattended day](#starting-stopping-and-the-unattended-day)
- [Reading the run monitor](#reading-the-run-monitor)
- [Every setting](#every-setting)
  - [Settings → Application mode](#settings--application-mode)
  - [Settings → Browser connections](#settings--browser-connections)
  - [Settings → ChatGPT sessions](#settings--chatgpt-sessions)
  - [Settings → Unsupported application sites](#settings--unsupported-application-sites)
  - [Settings → Documents and speed](#settings--documents-and-speed)
  - [Settings → Advanced writing preferences](#settings--advanced-writing-preferences)
  - [Settings → Local database](#settings--local-database)
  - [Settings → Unattended day](#settings--unattended-day)
  - [My profile](#my-profile)
  - [Job sources](#job-sources)
  - [Jobs & filters](#jobs--filters)
- [Things that will catch you out](#things-that-will-catch-you-out)
- [Troubleshooting](#troubleshooting)

---

## Install

1. Open `chrome://extensions` and switch on **Developer mode**.
2. **Load unpacked**, and choose this project folder. (Or unzip
   `dist/apply-bot-<version>.zip` and choose that.)
3. Click the toolbar icon. The workspace opens in Chrome's **side panel**.

The side panel and the full tab are the same page. Use **Full tab ↗** in the panel
when you want room for the resume editor or template studio.

Before the first run, sign in — in this same Chrome profile — to **ChatGPT**, to
**Gmail** (for emailed verification codes), and to any job feed you intend to use.
The bot uses your existing sessions and cannot sign in for you.

---

## First run in ten minutes

1. **My profile** — fill in contact details and work authorisation. Anything
   missing here becomes a form the bot has to hand back to you.
2. **My resumes** — upload at least one resume. It is the raw material every
   tailored version is written from.
3. **Job sources** — paste a few job links and press **Load links**.
4. **Run monitor → Start run**.

Out of the box the bot **submits for real**, collects jobs from feeds, and keeps
starting runs until the daily target is met. That is deliberate — a default that
quietly does nothing is not the safe choice it looks like. The thing actually
protecting you is step 1: a run refuses to start until your profile carries a
name, email, phone, location, start date and work-authorisation answer, so an
unconfigured install cannot send anything.

If you would rather read what it writes before anything leaves your machine, turn
**Review before sending** *on* in **Settings → Application mode** before step 4,
watch the first few, then turn it back off.

---

## The pages

| Page | What it is for |
|---|---|
| **Overview** | Starting point and current run at a glance |
| **Run monitor** | The live dashboard: charts, counts, and what each job is doing |
| **My resumes** | Your resumes, and every tailored version it generated |
| **Template studio** | The layout and styling of generated resumes |
| **Job sources** | Where jobs come from: pasted links, paired links, feeds |
| **Jobs & filters** | Everything collected, and the filters that decide what to apply to |
| **Applications** | What was sent, to whom, with the receipt |
| **Already applied** | Employers to leave alone, including imported history |
| **My profile** | Who you are, and the answers forms keep asking for |
| **Settings** | How the bot behaves |

---

## Starting, stopping, and the unattended day

**Start run** begins one run. A run works through the loaded links, then the feeds,
until it runs out of work or hits a limit.

**Stop** asks the run to wind down. It is not a kill switch: anything mid-submission
finishes first, so expect a short delay rather than an instant halt.

**Autopilot** (Settings → Unattended day) is what turns a single run into a day of
work. It starts the next run when one finishes, is interrupted by Chrome, or finds
nothing new.

> **Pressing Stop switches autopilot off.** This is deliberate — a supervisor that
> restarts a run a minute after you stopped it is a bot you cannot switch off. But
> it means that after every Stop you must re-check **Keep starting runs until the
> target is met** before the bot will work on its own again.

---

## Reading the run monitor

The top row answers the questions you actually have:

- **Scraped** — links found today.
- **In progress** — being worked on right now.
- **Holding for you** — filled in, but needs a human. Captchas and questions the
  profile cannot honestly answer end up here.
- **Applied** — confirmed submissions today.
- **Passed over** — duplicates, unsupported boards, or refused by your filters.
- **Employers** — distinct companies applied to today.

Below that, the **pipeline funnel** is the chart worth learning. It shows links
found → applications attempted → actually sent, with the drop at each step. A big
drop between *found* and *attempted* is a supply or filtering problem. A big drop
between *attempted* and *sent* is forms and verification. They need completely
different fixes, and the funnel is what tells them apart.

**What stopped an application** ranks the reasons. **Attempts by platform** shows
which boards the day actually went through — this is how "it only ever applies to
Greenhouse" becomes visible instead of being guessed at.

---

## Every setting

Defaults are given for each. Settings are read **when a run starts**, so changing
one mid-run has no effect until the next run.

Four cards save separately, and a change is lost if you press the wrong one:
*Settings* uses **Save changes**, *Unattended day* uses **Save day plan**, the role
filter uses **Save role filter**, and the optional filters use **Save filters**.

### Settings → Application mode

| Setting | Default | What it does |
|---|---|---|
| **Review before sending** | Off | Fills forms and leaves them open instead of submitting. Off by default, so the bot submits for real. Turn it **on** for a first run if you want to read what it writes before anything is sent. |
| **Application attempts per run** | 0 (unlimited) | Stops the run after this many attempts. `0` means unlimited. Skipped, filtered and unsupported listings don't count. |
| **Confirmed submissions per run** | 0 | Stops after this many *confirmed* submissions. `0` means no target. Set attempts to `0` to keep trying until this is met. Needs automatic submission. |
| **Pause between jobs (ms)** | 2000 | A flat wait between jobs. Separate from the per-board and per-employer pacing below. |
| **Form filler** | Apply module | *Apply module* drives each board through its own adapter and will attempt careers pages no adapter recognises. *Original filler* is the older code path — switch back if a board starts misbehaving. |

### Settings → Browser connections

| Setting | Default | What it does |
|---|---|---|
| **Let the bot create candidate accounts** | Off | Workday and similar show no form until you have an account with that employer. Creating one is a **permanent record in their recruiting system under your name and cannot be undone**, so it is off until you say otherwise. Off, those postings are left for you to register by hand. Needs the Workday password below. |
| **ChatGPT project or conversation URL** | empty | Point at a ChatGPT project holding your candidate context. Leave empty and keep the relevant conversation open instead. |
| **Workday account password** | empty | Used for Workday account creation and sign-in. The extension never supplies a password of its own. |

### Settings → ChatGPT sessions

| Setting | Default | What it does |
|---|---|---|
| **Concurrent ChatGPT requests** | 2 | *2* uses separate temporary chats for research and separate project chats for resumes. *1* uses a single session. Repeated tab or response failures drop this to one automatically; account limits stop the run. |

### Settings → Unsupported application sites

| Setting | Default | What it does |
|---|---|---|
| **Only collect jobs this bot can apply to** | On | Feeds usually name the application site. Jobs on boards the bot cannot fill are left out. Jobs whose site the feed doesn't name are still collected and opened. |
| **When the bot cannot submit** | Save the link | What to do with unsupported sites that still reach the run: *Save the link for later*, *Prepare documents for a manual application*, or *Skip the link*. |
| **Let the generic filler drive sites with no adapter** | Off | *Only hiring systems it has been checked against* or *Any site whose form it recognises*. The generic filler refuses password pages, ambiguous Submit buttons, empty required fields and visible captchas — **but it cannot refuse being wrong about a form it read badly, and a sent application cannot be recalled.** Leave off unless somebody is watching. |
| **Manual document limit per run** | 10 | Caps how many manual-application document sets are prepared per run. `0` means unlimited. |
| **Keep a tab open when a captcha blocks Submit** | Off | The form is filled and one click from being sent, but only on that page. **On**, the tab waits for you. **Off**, the typed answers are written to the manual-application folder and the tab is closed with the rest — which is what an unattended run wants, since nobody is there to make the click. |

### Settings → Documents and speed

| Setting | Default | What it does |
|---|---|---|
| **Generate optional cover letters** | Off | Off saves a ChatGPT request per application. On also writes letters for optional upload and text fields. Required letters are always written. |

### Settings → Advanced writing preferences

| Setting | Default | What it does |
|---|---|---|
| **Cover letter instructions** | empty | Free text passed to ChatGPT when writing letters — tone, length, things to emphasise or avoid. |
| **Application answer instructions** | empty | The same, for open-ended application questions. |

### Settings → Local database

| Setting | Default | What it does |
|---|---|---|
| **Also export application files to Downloads** | Off | Writes copies of resumes, letters and receipts to your Downloads folder. Copies only — the SQLite database stays the source of truth. |

### Settings → Unattended day

This card saves with its own **Save day plan** button, not *Save changes*.

| Setting | Default | What it does |
|---|---|---|
| **Keep starting runs until the target is met** (autopilot) | On | Starts the next run by itself when one finishes, is interrupted, or finds nothing new. **Pressing Stop turns this off.** |
| **Confirmed submissions per day** | 300 | The daily ceiling, counted across every run since midnight in your timezone, surviving Chrome restarts. `0` means no ceiling. 300 needs roughly 12.5 an hour sustained *and* 300 fresh postings a day on fillable boards. |
| **Applications at a time** | 2 | 1 to 4. An application waiting on an emailed code gives up its slot, so 2 is usually right; more adds tab contention without throughput. |
| **Seconds between applications to one board** | 45 | Per board, not overall. Applying to one board at machine speed invites a block, **which costs every remaining application on that board**, not just the current one. |
| **Roles per employer per day** | 3 | How many different openings at one company may be applied to in a day. Set to 1 to apply at most once per company. The same posting is never applied to twice whatever this says. |
| **Minutes between applications to one employer** | 20 | Three applications to one company inside a minute is what reads as automated. The queue works other employers while one waits, so this usually costs nothing. |
| **Minutes before an attempt is abandoned** | 12 | The queue stops waiting and records why. The attempt itself is left to finish or time out. |
| **Minutes before a Workday attempt is abandoned** | 25 | Workday is an account, a mailed activation and a multi-page wizard, so it gets longer. |
| **Minutes before an empty feed is read again** | 20 | Used when a complete round of enabled feeds found no new links. |

### My profile

Everything here exists so a form does not have to be handed back to you. The more
of it is filled in, the fewer applications stop for a human.

**Contact information** — First name, Last name, Email, Phone, City, State/region,
Country, Postal code, and **Street address** (required by Workday; many boards
never ask).

**Online profiles** — LinkedIn URL, GitHub URL, Website/portfolio.

**Work preferences**

| Setting | What it does |
|---|---|
| **Earliest start date** | Free text, e.g. "Two weeks after offer" |
| **Preferred arrangement** | Remote, Hybrid, On-site or Flexible |
| **Experience fallback (years)** | Used for generic "years of experience" fields. Set `0` if a single broad figure would be misleading |
| **Willing to relocate** | Yes / No |
| **Willing to travel** | Yes / No |
| **Salary range — bottom** | The figure used when a form asks for a minimum. `0` on both ends means compensation questions stop for you instead |
| **Salary range — top** | What you want. Used for "desired", "expected" and open-ended pay questions |
| **Salary period** | Per year, month, week, day or hour. Set this to match how you wrote the figures |
| **Salary currency** | Three-letter code, e.g. `USD` |

**How a pay question gets answered.** Three things are tried, in order. First the
bot researches the actual employer and role with ChatGPT web search, using this
prompt:

> Based on JD and company, tell me what compensation this position would be. Must
> be consider exact salary range of that kind of roles in the company.

It prefers the company's own postings and disclosures, falls back to comparable
companies and then to published market data, and says on the run record which of
those a figure came from. If that comes back with nothing usable, your range above
is typed instead. Only if you left both at `0` does the application stop and wait
for you.

The figures typed are always the ones you wrote — a "minimum" question gets the
bottom, everything else gets the top, and a box with room for a sentence gets
"$150,000 - $180,000 per year". Nothing is averaged and no third number is invented.
Leaving these at `0` is a reasonable choice if you would rather answer pay by hand,
but be aware that it was the single largest cause of stalled applications in
testing: fifteen in one night, more than captchas and demographics combined.

**Work authorization and standard questions** — the questions nearly every US
application asks: **US work authorization** (US citizen, Permanent resident, Visa
holder, Needs sponsorship), **Requires sponsorship**, **Age 18 or older**, **Subject
to a non-compete**, **Consent to background check**, **Previously employed
(fallback)**, and **Previous employers** (one per line; otherwise the resume
generated for that application is used).

**Criminal record** sits in the same card and defaults to **No record**, which
answers conviction, felony, misdemeanour and criminal-history questions with "No".
This is your own standing statement, not a guess the bot makes from your resume —
which is why it is a setting rather than a built-in assumption. Set it to *Leave
conviction questions to me* or *I have one* and every such question goes back to a
person instead. It never answers a security clearance, a professional licence, or
consent to a background check; those keep their own settings above.

**Standing answers** — your own answers to questions the bot would otherwise have
to hold.

| Setting | What it does |
|---|---|
| **Your own answers** | One per line, as `part of the question = your answer`. For example `security clearance = No, I have never held one`. The phrase is matched inside the question, ignoring case, and must be at least three characters |
| **Licences and certifications** | List them, or write `None`. **Left empty, any question about a licence holds the application** rather than guessing |

**Optional demographic answers** — Gender identity, Pronouns, Race/ethnicity,
Hispanic/Latino, Veteran status, Disability status, Transgender, Sexual
orientation. All optional; every one of them can be left blank or declined.

### Job sources

**Add job links**

| Setting | What it does |
|---|---|
| **Job posting URLs** | One link per line. Direct application links and aggregator postings both work. The extension chooses the resume |
| **Google Sheet URL** | A sheet shared with anyone who has the link. Links may be in any column |

Press **Load links** to queue them, **Clear queue** to empty it.

**Job links with their own resumes** — an explicit pairing: this posting, this
resume. One per line, the link and the resume label from *My resumes*, separated by
a comma, tab or vertical bar:

```
https://job-boards.greenhouse.io/acme/jobs/123 | My Backend Resume
https://jobs.lever.co/beta/456, ML Resume 2026
```

The supplied file is uploaded **exactly as it is** — nothing is tailored, rewritten
or regenerated for a paired job. **Check pairings** validates them up front, so a
resume that cannot be read is refused here rather than halfway through a form.
**Import a folder** reads the layout one directory per employer, the role inside it,
and a `job-link.txt` beside the resume PDF.

**Automatic discovery**

| Setting | Default | What it does |
|---|---|---|
| **Collect jobs from feeds** | On | Runs use loaded links first, then visit enabled feeds. On by default — with it off and no links loaded, a run has no job source at all |
| **Jobright recommendations** | On | Uses your signed-in Jobright tab |
| **Continue until no new jobs** | On | Keeps visiting feeds until a complete round finds nothing new. Filtered jobs do not end a run. Set *Application attempts per run* to `0` to remove the attempt limit |
| **Hiring Cafe search URL** | empty | Set your filters on Hiring Cafe and paste the search address here. Empty disables it |

### Jobs & filters

**Role filter** — the simple, explicit one.

| Setting | Default | What it does |
|---|---|---|
| **Only apply to these roles** | Off | **On:** a posting is applied to only if its title contains one of your phrases. **Off:** roles are judged automatically from jobs you have applied to before |
| **Roles you want** | empty | One per line or comma separated, e.g. `software engineer, full stack, machine learning`. Matching ignores case and seniority, so `machine learning` takes "Senior Machine Learning Engineer, Ranking" |

Turning this **on** is the reliable way to stop drift into roles you never wanted.
Left off, relevance is inferred from history — and history can poison itself, since
one off-target application teaches it that off-target titles are acceptable.

**Optional filters** — researched restrictions. Every one is optional; leave any at
*Any* to ignore it.

| Setting | Default | Options |
|---|---|---|
| **Enable job filters** | Off | Master switch. Profile preferences never silently enable restrictions |
| **Work arrangement** | Any | Any / Remote only / Remote or hybrid / Hybrid only / On-site only |
| **Required travel** | Any | Any / No required travel |
| **Security clearance** | Any | Any / No clearance required / No *active* clearance required |
| **On-site interviews** | Any | Any / No required on-site interview |
| **Location eligibility** | Any | Any / Must allow my profile location |
| **Employment type** | Any | Any / Full-time / Contract / Part-time |
| **Visa sponsorship** | Any | Any / Sponsorship must be available |
| **Relocation** | Any | Any / No required relocation |
| **On-call work** | Any | Any / No required on-call work |
| **When research cannot verify an enabled rule** | Balanced | *Balanced* holds only when it decides eligibility; *Strict* holds every unverified rule for review; *Allow* applies anyway and records what was unknown |
| **Allowed job title phrases** | empty | One per line. Any match is allowed. Empty allows all titles |
| **Excluded companies** | empty | One per line. Applied-company protection is always enforced separately |
| **Additional researched requirements** | empty | Free text, e.g. "No staffing agencies; no weekend shifts". Every clause needs evidence; unpublished requirements stay unknown |

> **The setting most likely to throttle you is "When research cannot verify an
> enabled rule."** On *Strict*, anything unverifiable becomes a review item, and an
> unattended night turns into a queue nobody empties. If you have enabled filters
> and almost everything is being held, look here first.

---

## Things that will catch you out

**Settings are read when a run starts.** Change the daily target, the pacing, or
the per-employer limit mid-run and nothing happens until the next run. Restart the
run to apply them.

**Stop switches autopilot off.** Every time. Re-enable it in *Unattended day*.

**Captcha tabs are closed by default.** A filled form behind a puzzle is one human
click from being sent, but only on that page — and overnight nobody makes that
click, so the window fills with forms nobody will finish. The typed answers are
written to the manual-application folder either way, so what closing costs is the
live form rather than the work. If you are sitting with the run, turn on **Keep a
tab open when a captcha blocks Submit** and they will wait for you.

**Questions your profile cannot answer still hold.** Those applications are filled
in and waiting — you only need to answer the one question and submit. Adding that
answer to **Standing answers** stops it recurring.

**300 a day needs 300 postings a day.** The ceiling is usually supply, not speed. A
single application takes roughly 90 seconds. If the funnel shows thousands found
and a handful attempted, the fix is filters and job sources, not performance. And
at *Roles per employer per day = 1*, 300 applications means 300 **distinct
companies**.

**Removing the board gap is a real risk.** The 45-second gap is the only thing
preventing a board from deciding your traffic is automated. A block costs every
remaining application on that board for the day.

---

## Troubleshooting

**The run stops immediately.** Something raised a health condition — ChatGPT signed
out, disk nearly full, a board failing every attempt. The *Needs you* card at the
top of the run monitor names the condition and the remedy. Pressing **Start run**
is what clears a condition you have dealt with.

**Nothing is being submitted.** Check *Review before sending* in Application mode —
if it is on, forms are filled and left open by design.

**It only applies through one board.** Look at *Attempts by platform* on the run
monitor. A board missing entirely was absent from the day's supply; a board present
with few sends is being blocked at the form, and *What stopped an application* says
how.

**It is applying to roles you don't want.** Turn on the **role filter** and list the
titles you want. Don't rely on automatic relevance.

**Everything is held for review.** Either your profile is missing answers the forms
need — fill in *Work authorization* and *Standing answers* — or *When research
cannot verify an enabled rule* is set to *Strict*.

**Too many tabs.** Tabs are reclaimed automatically once nothing is using them.
Tabs you own, captcha tabs, pinned tabs and anything you recently looked at are
never touched. During a run, job and feed tabs are deliberately kept until the run
ends, because nothing outside the run can tell what it still needs.
