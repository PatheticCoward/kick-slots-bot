// server.js
import 'dotenv/config';
import fs from 'fs/promises';
import express from 'express';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { MongoClient, ObjectId } from 'mongodb';
import axios from 'axios';

puppeteer.use(StealthPlugin());

const {
  KICK_USERNAME,
  KICK_PASSWORD,
  MONGODB_URI,
  CHANNEL_SLUG,
  DISCORD_WEBHOOK_URL,
  PORT = 3000
} = process.env;

if (!KICK_USERNAME) throw new Error('Missing KICK_USERNAME in .env');
if (!KICK_PASSWORD) throw new Error('Missing KICK_PASSWORD in .env');
if (!MONGODB_URI)   throw new Error('Missing MONGODB_URI in .env');
if (!CHANNEL_SLUG)  throw new Error('Missing CHANNEL_SLUG in .env');

const delay = ms => new Promise(res => setTimeout(res, ms));

async function dismissBanner(page) {
  try {
    const acceptBtn = await page.waitForXPath("//button[normalize-space()='Accept']", { timeout: 3000 });
    await acceptBtn.click();
    await page.waitForTimeout(500);
  } catch {}
  try {
    const rejectBtn = await page.waitForXPath("//button[normalize-space()='Reject']", { timeout: 3000 });
    await rejectBtn.click();
    await page.waitForTimeout(500);
  } catch {}
}

async function sendChatReply(page, text) {
  await dismissBanner(page);

  const handle = await page.waitForSelector('div[data-test="chat-input"]', { timeout: 5000 });
  await handle.click();
  await page.waitForTimeout(50);

  await page.evaluate((el, txt) => {
    el.innerHTML =
      `<p class="editor-paragraph">` +
        `<span data-lexical-text="true">${txt}</span>` +
      `</p>`;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, handle, text);

  const sendBtn = await page.$('button[data-test="send"], button[aria-label="Send"]');
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }
}

async function startBot(chats) {
  console.log('🚨 Starting Kick bot…');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-popup-blocking',
      '--no-first-run',
      '--remote-debugging-port=9222'
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent(/* … */);
  page.setDefaultNavigationTimeout(0);

  // ─── Cookie restore ──────────────────────────────────────
  console.log('🌐 Navigating to kick.com for cookie restore…');
  await page.goto('https://kick.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    const raw = await fs.readFile('./cookies.json', 'utf8');
    const cookies = JSON.parse(raw);
    await page.setCookie(...cookies);
    console.log('🔓 Restored session cookies');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('🔄 Page reloaded with cookies');
  } catch {
    console.log('🔒 No cookies.json found; will log in manually');
  }
  // ─────────────────────────────────────────────────────────

  await dismissBanner(page);

  // ─── New login flow ────────────────────────────────────
  // Click the account icon to open the dropdown
  const accountBtn = await page.waitForSelector(
    'button[data-test="navbar-account"], button[aria-label="account"]',
    { timeout: 10000 }
  );
  await accountBtn.click();
  await page.waitForTimeout(500);

  // Click the "Log in" entry
  const [loginEntry] = await page.$x(
    "//button[normalize-space()='Log in'] | //a[normalize-space()='Log in']"
  );
  if (loginEntry) {
    await loginEntry.click();
  } else {
    throw new Error("❌ Could not find the Log in button in the account menu");
  }

  // Wait for the login form inputs
  await page.waitForSelector(
    'input[name="username"], input[type="email"]',
    { timeout: 60000 }
  );
  const emailInput = await page.$('input[name="username"], input[type="email"]');
  const passInput  = await page.$('input[type="password"]');

  if (!emailInput || !passInput) {
    throw new Error("❌ Login inputs not found");
  }

  // Fill in credentials
  await emailInput.type(KICK_USERNAME, { delay: 50 });
  await passInput.type(KICK_PASSWORD, { delay: 50 });

  // Submit
  console.log('🚀 Submitting credentials…');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
    // Attempt to click the form's submit button:
    page.click('button[type="submit"], button[data-test="login-submit"]')
  ]);

  console.log('🔑 Please complete 2FA in the browser; waiting 60s…');
  await delay(60_000);

  // Save new cookies
  const freshCookies = await page.cookies();
  await fs.writeFile('./cookies.json', JSON.stringify(freshCookies, null, 2));
  console.log('🔒 Saved fresh session cookies');
  // ─────────────────────────────────────────────────────────

  // …then continue on to navigate to your chat page, hook WS, etc.
}

async function startServerAndBot() {
  const client = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  const chats = client.db().collection('chatMessages');
  console.log('✅ MongoDB connected');

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/slots', async (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const docs = await chats.find(filter).sort({ time: -1 }).toArray();
    res.json(docs);
  });

  app.delete('/api/slots/:id', async (req, res) => {
    await chats.deleteOne({ _id: new ObjectId(req.params.id) });
    res.sendStatus(204);
  });

  app.patch('/api/slots/:id', async (req, res) => {
    const { status } = req.body;
    if (!['IN','OUT'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await chats.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status } }
    );
    res.sendStatus(204);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🖥️ Server listening at http://0.0.0.0:${PORT}`);
  });

  startBot(chats).catch(err => {
    console.error('💥 Bot encountered an error:', err);
  });
}

startServerAndBot().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
