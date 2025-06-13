// server.js
import 'dotenv/config';
import fs from 'fs/promises';
import express from 'express';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import { MongoClient, ObjectId } from 'mongodb';

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
    await acceptBtn.click(); await page.waitForTimeout(500);
  } catch {}
  try {
    const rejectBtn = await page.waitForXPath("//button[normalize-space()='Reject']", { timeout: 3000 });
    await rejectBtn.click(); await page.waitForTimeout(500);
  } catch {}
}

async function sendChatReply(page, text) {
  await dismissBanner(page);
  const handle = await page.waitForSelector('div[data-test="chat-input"]', { timeout: 5000 });
  await handle.click(); await page.waitForTimeout(50);
  await page.evaluate((el, txt) => {
    el.innerHTML = `<p class="editor-paragraph"><span data-lexical-text="true">${txt}</span></p>`;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, handle, text);
  const sendBtn = await page.$('button[data-test="send"], button[aria-label="Send"]');
  if (sendBtn) await sendBtn.click();
  else await page.keyboard.press('Enter');
}

async function startBot(chats) {
  console.log('🚨 Starting Kick bot…');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/115.0.0.0 Safari/537.36'
  );

  // restore cookies
  try {
    const raw = await fs.readFile('./cookies.json', 'utf8');
    await page.setCookie(...JSON.parse(raw));
    console.log('🔓 Restored session cookies');
  } catch {
    console.log('🔒 No cookies.json found; will log in manually');
  }

  // initial navigation + banner
  console.log('🌐 Navigating to kick.com');
  await page.goto('https://kick.com', { waitUntil: 'networkidle2' });
  await dismissBanner(page);

  // login if needed
  const loginBtns = await page.$$('button[data-test="login"]');
  if (loginBtns.length > 0) {
    console.log('🔐 Performing login flow…');
    await loginBtns[0].click();
    await dismissBanner(page);
    await page.waitForSelector('div[role="dialog"] input', { timeout: 60000 });
    const inputs = await page.$$('div[role="dialog"] input');
    await inputs[0].type(KICK_USERNAME, { delay: 50 });
    await inputs[1].type(KICK_PASSWORD, { delay: 50 });
    console.log('🚀 Submitting credentials…');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
      page.click('div[role="dialog"] button[type="submit"]')
    ]);
    console.log('🔑 Complete 2FA in the browser; waiting 60s…');
    await delay(60_000);
    const fresh = await page.cookies();
    await fs.writeFile('./cookies.json', JSON.stringify(fresh, null, 2));
    console.log('🔒 Saved new session cookies');
  } else {
    console.log('✅ Already logged in via restored cookies');
  }

  // go to chat
  const chatURL = `https://kick.com/${CHANNEL_SLUG}/chat`;
  console.log(`🎯 Navigating to chat page: ${chatURL}`);
  await page.goto(chatURL, { waitUntil: 'networkidle2' });
  await dismissBanner(page);

  // listen for !slot messages
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', async ({ response }) => {
    try {
      const outer = JSON.parse(response.payloadData);
      if (!outer.data) return;
      const msg = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
      const content = msg.content;
      if (typeof content === 'string' && content.startsWith('!slot ')) {
        const slotText = content.slice(6).trim();

        // duplicate?
        if (await chats.findOne({ msg: slotText })) {
          await sendChatReply(page, `${msg.sender.username} this slot has already been called.`);
          return;
        }

        // save it
        const badges = msg.sender.identity.badges || [];
        const slot = {
          time: new Date(),
          user: msg.sender.username,
          msg: slotText,
          subscriber: badges.some(b => b.type === 'subscriber'),
          vip: badges.some(b => b.type === 'vip'),
          moderator: badges.some(b => b.type === 'moderator')
        };
        await chats.insertOne(slot);
        console.log('➕ Saved slot:', slot);

        // → Discord
        if (DISCORD_WEBHOOK_URL) {
          try {
            await axios.post(DISCORD_WEBHOOK_URL, {
              content: `🎰 **New slot**: **${slot.user}** called \`${slot.msg}\``
            });
            console.log('✅ Sent slot to Discord');
          } catch (e) {
            console.error('❌ Discord webhook error:', e.message);
          }
        }

        // → Kick confirmation
        await sendChatReply(page, `Your slot has been added to the list, ${slot.user}`);
        console.log('💬 Sent confirmation reply');
      }
    } catch {}
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
    res.json(await chats.find(filter).sort({ time: -1 }).toArray());
  });
  app.delete('/api/slots/:id', async (req, res) => {
    await chats.deleteOne({ _id: new ObjectId(req.params.id) });
    res.sendStatus(204);
  });
  app.patch('/api/slots/:id', async (req, res) => {
    const { status } = req.body;
    if (!['IN','OUT'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await chats.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
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
