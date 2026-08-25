import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, ".browser-profile");
const START_URL = process.env.JOYBUY_LOGIN_URL || "https://www.joybuy.de/";

const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
  viewport: { width: 1365, height: 900 }
});

const page = await browser.newPage();
await page.goto(START_URL, { waitUntil: "domcontentloaded" });

console.log("A Chromium window is open.");
console.log("Log in to Joybuy there, confirm the delivery region if prompted, then press Enter here.");

await new Promise((resolve) => process.stdin.once("data", resolve));
await browser.close();
console.log(`Saved browser profile at ${PROFILE_DIR}`);
