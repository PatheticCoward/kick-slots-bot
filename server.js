// server.js
import 'dotenv/config';
import fs from 'fs/promises';
import express from 'express';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { MongoClient, ObjectId } from 'mongodb';

puppeteer.use(StealthPlugin());

const {
  KICK_USERNAME,
  KICK_PASSWORD,
  MONGODB_URI,
  CHANNEL_SLUG,
  PORT = 3000
} = process.env;

if (!KICK_USERNAME) throw new Error('Missing KICK_USERNAME in .env');
if (!KICK_PASSWORD) throw new Error('Missing KICK_PASSWORD in .env');
if (!MONGODB_URI)   throw new Error('Missing MONGODB_URI in .env');
if (!CHANNEL_SLUG)  throw new Error('Missing CHANNEL_SLUG in .env');

const delay = ms => new Promise(res => setTimeout(res, ms));

async function sendChatReply(page, text) {
  // 1) Dismiss any cookie banner
  for (let sel of ["button[data-test='accept-cookies']", "button[data-test='reject-cookies']"]) {
    const btn = await page.$(sel);
    if (btn) { await btn.click(); await delay(500); }
  }

  // 2) Find and click the Kick chat-input div
  const inputHandle = await page.waitForSelector(
    'div[data-test="chat-input"]',
    { timeout: 5000 }
  );
  await inputHandle.click();               // <-- new click
  await delay(50);

  // 3) Inject the Lexical‐formatted HTML
  await page.evaluate((el, txt) => {
    el.innerHTML =
      `<p class="editor-paragraph">` +
        `<span data-lexical-text="true">${txt}</span>` +
      `</p>`;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, inputHandle, text);

  // 4) Send via button or Enter
  const sendBtn =
    await page.$('button[data-test="send"]') ||
    await page.$('button[aria-label="Send"]');
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }
}

async function startBot(chats) {
  console.log('🚨 Starting Kick bot…');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/115.0.0.0 Safari/537.36'
  );

  // Restore cookies if available
  try {
    const raw = await fs.readFile('./cookies.json', 'utf8');
    await page.setCookie(...JSON.parse(raw));
    console.log('🔓 Restored session cookies');
  } catch {
    console.log('🔒 No cookies.json — will log in manually');
  }

  // Navigate & login
  console.log('🌐 Navigating to kick.com');
  await page.goto('https://kick.com', { waitUntil: 'networkidle2' });
  const loginBtns = await page.$$('button[data-test="login"]');
  if (loginBtns.length >= 2) {
    console.log('🔐 Performing login…');
    const [accept] = await page.$x("//button[normalize-space()='Accept']");
    if (accept) { console.log('🍪 Accepting cookies'); await accept.click(); await delay(500); }
    await loginBtns[1].click();
    console.log('⏳ Waiting for login dialog…');
    await page.waitForSelector('div[role="dialog"] input', { timeout: 60000 });
    const inputs = await page.$$('div[role="dialog"] input');
    await inputs[0].type(KICK_USERNAME, { delay: 50 });
    await inputs[1].type(KICK_PASSWORD, { delay: 50 });
    console.log('🚀 Submitting creds…');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
      page.click('div[role="dialog"] button[type="submit"]')
    ]);
    console.log('🔑 Waiting for 2FA… 60s');
    await delay(60_000);
    await fs.writeFile(
      './cookies.json',
      JSON.stringify(await page.cookies(), null, 2)
    );
    console.log('🔒 Saved session cookies');
  } else {
    console.log('✅ Already logged in via cookies');
  }

  // Go to chat
  const chatURL = `https://kick.com/${CHANNEL_SLUG}/chat`;
  console.log(`🎯 Navigating to chat page: ${chatURL}`);
  await page.goto(chatURL, { waitUntil: 'networkidle2' });

  // Dismiss chat-page banner
  try {
    const [acc2] = await page.$x("//button[normalize-space()='Accept']");
    if (acc2) { console.log('🍪 Dismissing chat banner'); await acc2.click(); await delay(500); }
  } catch {}

  // Listen for !slots
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', async ({ response }) => {
    try {
      const outer = JSON.parse(response.payloadData);
      if (!outer.data) return;
      const msg = typeof outer.data === 'string'
        ? JSON.parse(outer.data)
        : outer.data;

      const text = msg.content;
      if (typeof text === 'string' && text.startsWith('!slot ')) {
        const slotMsg = text.slice(6).trim();
        // Duplicate?
        const exists = await chats.findOne({ msg: slotMsg });
        if (exists) {
          const warning = `${msg.sender.username} this slot has already been called.`;
          await sendChatReply(page, warning);
          console.log('💬 Sent duplicate warning');
          return;
        }
        // Insert
        const badges = msg.sender.identity.badges || [];
        const slot = {
          time:       new Date(),
          user:       msg.sender.username,
          msg:        slotMsg,
          subscriber: badges.some(b => b.type === 'subscriber'),
          vip:        badges.some(b => b.type === 'vip'),
          moderator:  badges.some(b => b.type === 'moderator')
        };
        await chats.insertOne(slot);
        console.log('➕ Saved slot:', slot);
        // Confirm
        const confirm = `Your slot has been added to the list, ${slot.user}`;
        await sendChatReply(page, confirm);
        console.log('💬 Sent confirmation reply');
      }
    } catch {
      // ignore
    }
  });

  console.log('🚨 Bot is up — listening for !slot messages');
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

  app.listen(PORT, () => {
    console.log(`🖥️ Server listening at http://localhost:${PORT}`);
  });

  startBot(chats).catch(err => {
    console.error('💥 Bot encountered an error:', err);
  });
}

startServerAndBot().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
