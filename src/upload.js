/**
 * Sending a finished application to a service outside the browser.
 *
 * Everything the bot produces lands in two places today: the SQLite
 * workspace, which is the record, and - when the switch is on - a copy
 * of each application's folder under Downloads. Neither reaches
 * anything else, so a tracker kept elsewhere has to be typed up by
 * hand from folders the bot already wrote.
 *
 * This is the third place an application can land. One POST per
 * application, carrying the four facts about the job and the resume
 * file that was actually sent to the employer - not a regenerated one,
 * not the library copy, the bytes that went - so the tracker holds the
 * same application the employer holds.
 *
 * Multipart rather than JSON, because the resume is a file and the
 * endpoint takes it as one. The key travels in a header.
 *
 * Nothing here ever fails an application. By the time this runs the
 * form has been submitted and the record written; an endpoint that is
 * down, renamed or refusing the key is a copy that did not arrive, and
 * the application stands either way. That is why every failure comes
 * back as a reason rather than an exception the caller has to catch,
 * and why the reason is kept on the record - "Send past applications"
 * is how one gets another go.
 */

/** The fields the endpoint will not take an application without. */
export const REQUIRED = ["name", "jobTitle", "companyName", "description"];

/**
 * Long enough for a slow upload of a resume over a slow line, short
 * enough that an endpoint which has stopped answering cannot hold an
 * attempt open. The application is already sent when this runs, so
 * waiting longer buys nothing.
 */
export const UPLOAD_TIMEOUT_MS = 30000;

/**
 * What is configured, and what is missing.
 *
 * Returned rather than thrown so a half-filled setup can be described
 * on screen and in the log in the same words: the switch is on, and
 * this is the part that is not filled in yet.
 */
export function uploadSettings(profile = {}) {
  const url = String(profile.uploadUrl ?? "").trim();
  const apiKey = String(profile.uploadApiKey ?? "").trim();
  const on = profile.uploadEnabled === true;
  const missing = [];
  if (!url) missing.push("the upload address");
  else if (!/^https?:\/\//i.test(url)) missing.push("a valid upload address");
  if (!apiKey) missing.push("the API key");
  return { on, url, apiKey, missing, ready: on && missing.length === 0 };
}

/**
 * The job, as the endpoint wants it.
 *
 * `jd` is the extracted posting text, which is the same text the resume
 * was written from - so what the tracker stores as the description is
 * what the bot actually read, not the aggregator's summary of it.
 */
export function uploadFields(application = {}, profile = {}) {
  return {
    name: `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim(),
    jobTitle: String(application.title ?? "").trim(),
    companyName: String(application.company ?? "").trim(),
    description: String(application.jd ?? application.description ?? "").trim(),
  };
}

/** The fields with nothing in them, named the way the endpoint names them. */
export const missingFields = (fields = {}) => REQUIRED.filter((key) => !String(fields[key] ?? "").trim());

/**
 * The resume as something `FormData` will take.
 *
 * It arrives as a Blob from the generator and as a Blob from the file
 * store, but a record written by an older build can hold the bytes
 * themselves, and a bare `Uint8Array` appended to a form is sent as the
 * string "[object Uint8Array]" rather than refused - a corrupt upload
 * that looks like a successful one.
 */
export function resumeBlob(resume) {
  if (!resume) return null;
  if (resume instanceof Blob) return resume;
  if (resume instanceof ArrayBuffer || ArrayBuffer.isView(resume)) return new Blob([resume], { type: "application/pdf" });
  return null;
}

/**
 * One application, sent.
 *
 * Resolves to `{ok:true, ...}` with whatever the endpoint returned, or
 * `{ok:false, error}` saying why not. It does not throw: see the head
 * of this file.
 */
export async function uploadApplication({ url, apiKey, fields, resume, resumeName = "resume.pdf" }, { fetch = globalThis.fetch, timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  const absent = missingFields(fields);
  if (absent.length) return { ok: false, error: `the upload needs ${absent.join(", ")}` };
  const file = resumeBlob(resume);
  if (!file) return { ok: false, error: "no resume file was kept for this application" };

  const form = new FormData();
  for (const key of REQUIRED) form.append(key, String(fields[key]));
  form.append("resume", file, resumeName);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A name that does not resolve, a refused connection, a certificate
    // the browser will not take, or the timeout above. All of them read
    // the same way to somebody looking at the log: it did not arrive.
    const reason = error?.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)}s` : error?.message ?? String(error);
    return { ok: false, error: `could not reach the upload service: ${reason}` };
  }

  // The endpoint answers JSON, but a proxy in front of it answers HTML
  // and a dead host answers nothing - and `response.json()` throwing on
  // a 502 would otherwise be reported as a parse error rather than as
  // the 502 it is.
  const text = await response.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!response.ok) {
    const said = data?.error || (text && text.length <= 200 ? text.trim() : "");
    return { ok: false, error: said ? `${said} (${response.status})` : `upload failed (${response.status})`, status: response.status };
  }
  return { ok: true, status: response.status, resumeLink: data?.resumeLink ?? "", job: data?.job ?? null };
}
