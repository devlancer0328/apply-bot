/**
 * Where tests put browser profiles, downloads and generated certificates.
 *
 * All of this used to go in `.tools/` inside the extension root, which is
 * the directory Chrome loads unpacked. Fifty abandoned Playwright profiles
 * and a copy of a real Chrome profile tree grew it to 1.3 GB, so every
 * `--load-extension` was handing Chrome a 1.5 GB extension to scan, and the
 * certificate `apply-standalone.mjs` generates made Chrome warn on every
 * single load that the extension ships a private key file. Nothing a test
 * writes belongs inside the thing under test, so it all lives out here now.
 *
 * Set APPLY_BOT_SCRATCH to put it somewhere else - another disk, or a
 * tmpfs. The default sits under the XDG cache directory because every byte
 * of it is regenerable by re-running the test that made it.
 */

import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const scratchRoot = resolve(process.env.APPLY_BOT_SCRATCH ?? resolve(process.env.XDG_CACHE_HOME ?? resolve(homedir(), ".cache"), "apply-bot-scratch"));

/** Portable Chromium builds, probed for as `chromium-<digits>` by the browser tests. */
export const browsersDir = resolve(scratchRoot, "browsers");

await mkdir(scratchRoot, { recursive: true });

export const scratchPath = (label) => resolve(scratchRoot, `${label}-${Date.now()}`);

/**
 * Remove a scratch directory, but only when the run passed.
 *
 * A failed run's profile is the only copy of the browser state that
 * produced the failure, which is presumably why nobody ever cleaned these
 * up: unconditional teardown destroys the evidence exactly when it is
 * wanted. Callers that catch their own failures set `process.exitCode`
 * before the finally block runs, so the default reads it; callers with no
 * catch block must pass `passed` themselves, because a thrown error on its
 * way out through a finally has not set an exit code yet.
 */
export const releaseScratch = async (path, passed = !process.exitCode) => { if (passed) await rm(path, { recursive: true, force: true }).catch(() => {}); };
