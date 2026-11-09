/**
 * Runs the extension inside the user's own Chrome, on their own profile.
 *
 * Getting here took ruling out everything else. Chrome refuses a debugger
 * against its default data directory, so the profile had to be relocated and
 * symlinked back. Chrome stable no longer side-loads an unpacked extension
 * from the command line, so it is installed over CDP instead - and that
 * method is only offered on the pipe transport, never the port, which is why
 * Chrome is launched here rather than attached to.
 *
 * The password store is named explicitly because Chrome guesses it from the
 * desktop environment, which is not there when it is started from a script;
 * guessing wrong means it derives the wrong key, silently decrypts nothing,
 * and comes up signed out of everything.
 */
import { chromium } from "playwright";

const ROOT = "/home/administrator/Downloads/scripts";
const USER_DATA = "/home/administrator/chrome-data";
const PROFILE = process.env.CHROME_PROFILE ?? "Profile 41";

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: "chrome",
  headless: false,
  viewport: null,
  // Playwright turns every extension off by default, which is sensible for a
  // throwaway profile and alarming on someone's real one - their password
  // manager and ad blocker simply vanish. Ours is installed over CDP below,
  // so nothing here needs that switch.
  ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
  args: [
    `--profile-directory=${PROFILE}`,
    "--enable-unsafe-extension-debugging",
    // A port as well as the pipe: the pipe belongs to whoever launched the
    // browser, so without this a later test run has no way back in.
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    "--password-store=gnome-libsecret",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

const cdp = await context.browser()?.newBrowserCDPSession();
let extensionId = null;
try {
  ({ id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: ROOT }));
  console.log("extension installed:", extensionId);
} catch (error) {
  console.log("extension install failed:", error.message);
}

// A profile that opens signed out looks identical to one that opened fine
// until an application is already half sent, so it is checked up front.
const probe = await context.newPage();
await probe.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded" });
const signedIn = !/signin|ServiceLogin/.test(probe.url());
console.log("google session:", signedIn ? "live" : "ABSENT", "-", probe.url().slice(0, 80));

const cookies = await context.cookies();
console.log(`cookies: ${cookies.length} across ${new Set(cookies.map((c) => c.domain)).size} domains`);

const workspace = `chrome-extension://${extensionId}/src/options.html`;
if (extensionId) {
  const page = await context.newPage();
  // Another extension in this profile can refuse the navigation, which says
  // nothing about whether ours loaded - so it is reported, not thrown.
  await page.goto(workspace).then(
    async () => console.log("workspace page:", await page.title()),
    (error) => console.log(`could not open the workspace automatically (${error.message.split("\n")[0]}); open it by hand:\n  ${workspace}`),
  );
}

const worker = context.serviceWorkers().find((w) => w.url().includes(extensionId ?? "\0"));
console.log("service worker:", worker ? "registered" : "not seen yet");

console.log("\nChrome is open on your profile with the extension installed. Leaving it running; close the window when you are done.");
await new Promise(() => {});
