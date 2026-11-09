/**
 * Keep the debuggable browser alive for the length of an unattended night.
 *
 * Chrome died once tonight with the disk at 98% and systemd-style session
 * recovery brought it straight back - but without `--remote-debugging-port`,
 * which is the one flag the run depends on. Nothing noticed. The extension
 * was gone, the queue stopped, and the only evidence was a watch file whose
 * heartbeat had quietly stopped advancing hours earlier. An unattended run
 * that cannot survive its own browser restarting is not unattended.
 *
 * This polls the debugging port and, when it has been gone for two
 * consecutive checks, relaunches Chrome on the same profile and presses Run.
 * Two checks rather than one because a reload deliberately drops the port
 * for a few seconds, and racing that would fight the operator.
 *
 *   node scripts/browser-watchdog.mjs
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, unlinkSync } from "node:fs";

const PORT = process.env.PORT ?? "9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";
const USER_DATA = process.env.USER_DATA ?? "/home/administrator/chrome-data";
const PROFILE = process.env.PROFILE ?? "Profile 39";
const LOG = "test-results/browser-watchdog.log";

mkdirSync("test-results", { recursive: true });
const say = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(LOG, stamped + "\n");
};

async function portAlive() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

function relaunch() {
  // The singleton files name a process that no longer exists after a crash,
  // and Chrome would rather join that ghost than start fresh, which is how a
  // relaunch silently becomes "Opening in existing browser session".
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { unlinkSync(`${USER_DATA}/${name}`); } catch {}
  }
  const child = spawn("/opt/google/chrome/chrome", [
    `--user-data-dir=${USER_DATA}`,
    `--profile-directory=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--restore-last-session",
  ], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
  });
  child.unref();
}

function pressRun() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/run-control.mjs"], {
      env: { ...process.env, ACT: "run", EXT_ID },
      stdio: "ignore",
    });
    child.on("close", resolve);
  });
}

let misses = 0;
say(`watching port ${PORT}`);
for (;;) {
  if (await portAlive()) {
    misses = 0;
  } else if (++misses >= 2) {
    say(`debugging port gone for ${misses} checks - relaunching Chrome`);
    relaunch();
    await new Promise((resolve) => setTimeout(resolve, 30000));
    if (await portAlive()) {
      await pressRun();
      say("Chrome is back and Run has been pressed");
    } else {
      say("relaunch did not bring the port back; will try again");
    }
    misses = 0;
  }
  await new Promise((resolve) => setTimeout(resolve, 60000));
}
