/**
 * The candidate's facts, in the shape the field resolver and the model read.
 *
 * This is deliberately an input to the apply module rather than something it
 * builds. Apply does not own who the person is; it is handed the facts and
 * holds them steady for the length of one attempt. A module that assembled
 * its own view of the candidate would be a second place for "does this
 * person need sponsorship" to be decided, and the answer to that question
 * has to have exactly one source.
 *
 * Lifted from the run loop unchanged so the two agree field for field while
 * both exist. They collapse into one at cutover.
 */

/** The profile's authorization setting, in words a model can use. */
const AUTHORIZATION_WORDS = {
  "us-citizen": "US citizen, authorized to work in the United States without sponsorship",
  "permanent-resident": "lawful permanent resident, authorized to work in the United States without sponsorship",
  "visa-holder": "visa holder, currently authorized to work in the United States",
  "needs-sponsorship": "will require visa sponsorship to work in the United States",
};

const NO_EDUCATION = { degree: "", school: "", location: "", year: "" };

export function answerContext(request, profile) {
  return {
    company: request.company,
    title: request.title,
    jd: request.jd,
    letter: request.letterText ?? "",
    // The resume written for this posting when there is one, and the pasted
    // career behind all of them otherwise.
    resume: request.resumeText ?? "",
    compensation: request.compensation,
    currentRole: request.currentRole ?? "",
    currentCompany: request.currentCompany ?? "",
    currentlyEmployed: /present|current|ongoing|now/i.test(request.resumeData?.experience?.[0]?.endDate || ""),
    education: request.education ?? NO_EDUCATION,
    // The person, as distinct from the career. See facts() in ai.js.
    location: [profile.city, profile.state, profile.country].filter(Boolean).join(", "),
    country: profile.country || "",
    remotePreference: profile.remotePreference,
    startDate: profile.startDate,
    workAuthorization: AUTHORIZATION_WORDS[profile.workAuthorization] ?? "",
    sponsorship: profile.requiresSponsorship === "yes" ? "will need sponsorship" : "does not need sponsorship, now or in the future",
    relocation: profile.willingToRelocate === "yes" ? "willing to relocate" : profile.willingToRelocate === "no" ? "not willing to relocate" : "not specified",
    travel: profile.willingToTravel === "no" ? "not able to travel" : profile.willingToTravel === "yes" ? "able to travel when the role requires it" : "not specified",
    phone: profile.phone,
    email: profile.email,
    // Said outright, because the tailored resume names some of the
    // posting's tools and not others, and a model asked about one it does
    // not name answered "0-1 years" and "None" for the title it was used
    // under - two fields above a resume claiming the stack.
    extraFacts: [
      "Only claim technology experience explicitly supported by the supplied resume. Do not treat the job description as candidate experience.",
    ],
  };
}
