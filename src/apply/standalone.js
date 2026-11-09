/**
 * Applying to one job, with no run in progress.
 *
 * This is the apply module's front door: a URL or an already-open tab goes
 * in, an outcome comes out. It exists separately from the run loop because
 * the two have genuinely different jobs - the loop decides *which* jobs are
 * worth applying to and how many at once, and this decides what happens to
 * one of them. Tangling those together is what made the old path impossible
 * to exercise on its own, and a thing that cannot be run on its own cannot
 * really be tested either.
 *
 * The services are injected rather than imported, and their defaults are
 * loaded only when they are not supplied. That is partly so a test can
 * substitute a deterministic model, and partly because the real ones reach
 * ChatGPT, the database and a mailbox: a caller that has already done the
 * research should not be made to load all three to say so.
 */

import { createAdapterRegistry } from "./contract.js";
import { applyTo } from "./engine.js";
import { chromeBrowserOps } from "./chrome-ops.js";
import { ashbyAdapter } from "./adapters/ashby.js";
import { genericAdapter } from "./adapters/generic.js";
import { greenhouseAdapter } from "./adapters/greenhouse.js";
import { leverAdapter } from "./adapters/lever.js";
import { ripplingAdapter } from "./adapters/rippling.js";
import { workableAdapter } from "./adapters/workable.js";
import { workdayAdapter } from "./adapters/workday.js";
import { answerContext } from "./answer-context.js";

/**
 * The adapters. Order decides nothing - confidence does - so this list only
 * has to be complete. The generic one is in it on the same terms as the
 * rest and wins nothing it is not left: it answers CONFIDENCE.GENERIC,
 * which is below every other rank, so it drives only the pages all six
 * board adapters have already declined.
 */
export function applyRegistry(adapters = [greenhouseAdapter, workableAdapter, ashbyAdapter, workdayAdapter, leverAdapter, ripplingAdapter, genericAdapter]) {
  return createAdapterRegistry(adapters);
}

/**
 * Apply to one job.
 *
 * `tabId` adopts a tab that is already open on the posting instead of
 * opening a second one. `policy.review` is on by default, and is the
 * difference between filling a form and sending it - the safer of the two
 * is what you get by not saying.
 *
 * `policy.register` is the other one of those, and it is the only part of
 * the policy that comes out of the profile rather than out of the caller.
 * Creating a candidate account on an employer's Workday is not a step in
 * an application, it is a durable record under the applicant's name that
 * nobody can delete, so the answer belongs to the person whose name it is
 * and has to survive past the end of one run. A caller may still say
 * otherwise - a harness proving the wall holds needs to - but saying
 * nothing gets whatever the applicant chose, which on a fresh install is
 * no.
 */
export async function applyToJob({ job, documents = {}, profile, policy = {}, tabId, services = {}, adapters, log = () => {} }) {
  const request = {
    id: job.id ?? job.applyUrl,
    company: job.company,
    title: job.title ?? "",
    applyUrl: job.applyUrl,
    sourceUrl: job.sourceUrl ?? "",
    jd: job.jd ?? "",
    profile,
    documents,
    compensation: job.compensation ?? null,
    resumeText: job.resumeText ?? "",
    letterText: job.letterText ?? "",
    resumeData: job.resumeData ?? null,
    education: job.education,
    currentRole: job.currentRole ?? "",
    currentCompany: job.currentCompany ?? "",
    policy: { review: true, register: Boolean(profile?.allowAccountRegistration), ...policy },
    tabId,
  };
  request.answerContext = job.answerContext ?? answerContext(request, profile);
  // One BrowserOps for the attempt and for the services behind it. The
  // mailbox reader has to take its turns on the same foreground queue as
  // the form; two queues would be no queue at all.
  const browser = chromeBrowserOps();

  return applyTo({
    request,
    registry: applyRegistry(adapters),
    browser,
    services: { ...(await defaultServices(services, { browser, log })), ...services },
    log,
  });
}

/**
 * The real sub-agents, imported only when the caller did not bring its own.
 *
 * Each of these is somebody else's module. Apply asks and waits; it does not
 * grow a second copy of any of them, which is the rule that kept the old run
 * loop from ending up with two compensation researchers.
 */
async function defaultServices(supplied, { browser, log } = {}) {
  const services = {};

  if (!supplied.answers) {
    const { answerAll } = await import("../ai.js");
    services.answers = (questions, context, profile) => answerAll(questions, context, profile);
  }

  if (!supplied.claimCompany) {
    const { claimSubmission } = await import("../store.js");
    services.claimCompany = (request) => claimSubmission(request);
  }

  if (!supplied.verification) {
    // A registered wait, not a held turn. Reading a mailbox takes minutes,
    // and the twelve-hour stall in the old flow was this call sitting
    // inside one `atFront` for the whole of its timeout; verification.js
    // takes a turn per look and leaves the front free between them.
    const { createVerificationService } = await import("./verification.js");
    services.verification = createVerificationService({ browser, log }).verification;
  }

  return services;
}
