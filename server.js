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

if (!KICK_USERNAME)  throw new Error('Missing KICK_USERNAME');
if (!KICK_PASSWORD)  throw new Error('Missing KICK_PASSWORD');
if (!MONGODB_URI)    throw new Error('Missing MONGODB_URI');
if (!CHANNEL_SLUG)   throw new Error('Missing CHANNEL_SLUG');

const delay = ms => new Promise(res => setTimeout(res, ms));

// ─── SSE BROADCAST SETUP ─────────────────────────────────────────────
const sseClients = [];
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ─── HELPERS ─────────────────────────────────────────────────────────
async function dismissBanner(page) {
  for (let txt of ['Accept', 'Reject']) {
    try {
      const [btn] = await page.$x(`//button[normalize-space()='${txt}']`);
      if (btn) { await btn.click(); await delay(500); }
    } catch {}
  }
}

async function sendChatReply(page, text) {
  try {
    await dismissBanner(page);
    const input = await page.waitForSelector('div[data-test="chat-input"]', { timeout: 5000 });
    await page.evaluate(el => el.focus(), input);
    await delay(50);
    await page.keyboard.type(text, { delay: 25 });
    const sendBtn =
      await page.$('button[data-test="send"]') ||
      await page.$('button[aria-label="Send"]');
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
  } catch (err) {
    console.error('❌ sendChatReply threw:', err);
    throw err;
  }
}

async function getCurrentSession(sessions, timeoutMs = 2 * 60 * 60 * 1000) {
  const now = new Date();
  let session = await sessions.find().sort({ lastActivity: -1 }).limit(1).next();
  if (!session || (now - new Date(session.lastActivity) > timeoutMs)) {
    const label = now.toISOString().slice(0,16).replace('T',' ');
    const { insertedId } = await sessions.insertOne({
      startTime: now,
      lastActivity: now,
      label
    });
    session = { _id: insertedId, startTime: now, lastActivity: now, label };
    console.log('🆕 Created new session:', label);
  } else {
    console.log('🔄 Reusing session:', session.label);
  }
  return session;
}

// ─── BOT LOGIC ───────────────────────────────────────────────────────
async function startBot(chats, sessions) {
  console.log('🚨 Starting Kick bot…');
  const currentSession = await getCurrentSession(sessions);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
  );

  // Restore cookies if present
  try {
    const raw = await fs.readFile('./cookies.json','utf8');
    await page.setCookie(...JSON.parse(raw));
    console.log('🔓 Restored cookies');
  } catch {
    console.log('🔒 No cookies, manual login required');
  }

  console.log('🌐 Navigating to kick.com');
  await page.goto('https://kick.com', { waitUntil: 'networkidle2' });
  await dismissBanner(page);

  const loginBtns = await page.$$('button[data-test="login"]');
  if (loginBtns.length) {
    console.log('🔐 Logging in…');
    await loginBtns[0].click();
    await dismissBanner(page);
    await page.waitForSelector('div[role="dialog"] input',{timeout:60000});
    const inputs = await page.$$('div[role="dialog"] input');
    await inputs[0].type(KICK_USERNAME,{delay:50});
    await inputs[1].type(KICK_PASSWORD,{delay:50});
    await Promise.all([
      page.waitForNavigation({waitUntil:'networkidle2',timeout:60000}),
      page.click('div[role="dialog"] button[type="submit"]')
    ]);
    console.log('🔑 Waiting 60s for 2FA…');
    await delay(60000);
    await fs.writeFile('./cookies.json', JSON.stringify(await page.cookies(),null,2));
    console.log('🔒 Saved cookies');
  } else {
    console.log('✅ Already logged in via cookies');
  }

  const chatURL = `https://kick.com/${CHANNEL_SLUG}/chat`;
  console.log('🎯 Navigating to chat page:', chatURL);
  await page.goto(chatURL,{waitUntil:'networkidle2'});
  await dismissBanner(page);

  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', async ({ response }) => {
    try {
      const outer = JSON.parse(response.payloadData);
      if (!outer.data) return;
      const msg = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
      const content = msg.content?.trim();
      if (!content) return;

      // !myslots command
      if (content === '!myslots') {
        const user = msg.sender.username;
        const userSlots = await chats.find({ sessionId: currentSession._id, user }).toArray();
        const pending = userSlots.filter(s => !s.status).map(s => s.msg);
        const inA = userSlots.filter(s => s.status === 'IN').map(s => s.msg);
        const outA = userSlots.filter(s => s.status === 'OUT').map(s => s.msg);
        const reply = `${user} - Slots in queue: ${pending.length? pending.join(', '): 'none'}; IN: ${inA.length? inA.join(', '): 'none'}; OUT: ${outA.length? outA.join(', '): 'none'}`;
        console.log('🔍 !myslots ➜', reply);
        await sendChatReply(page, reply);
        return;
      }

      // !slot command
      if (content.startsWith('!slot ')) {
        const slotMsg = content.slice(6).trim();

        // Update session activity
        await sessions.updateOne({ _id: currentSession._id }, { $set: { lastActivity: new Date() } });

        // Duplicate check
        if (await chats.findOne({ sessionId: currentSession._id, msg: slotMsg })) {
          const warning = `${msg.sender.username} this slot has already been called.`;
          console.log('🔍 duplicate ➜', warning);
          await sendChatReply(page, warning);
          return;
        }

        // Save new slot
        const badges = msg.sender.identity.badges || [];
        const slot = {
          sessionId: currentSession._id,
          time:      new Date(),
          user:      msg.sender.username,
          msg:       slotMsg,
          subscriber: badges.some(b => b.type === 'subscriber'),
          vip:         badges.some(b => b.type === 'vip'),
          moderator:   badges.some(b => b.type === 'moderator')
        };
        const { insertedId } = await chats.insertOne(slot);
        slot._id = insertedId;
        console.log('➕ Saved slot:', slot);

        // Broadcast new slot to SSE clients
        broadcast('slot', slot);

        // Discord notification
        if (DISCORD_WEBHOOK_URL) {
          try {
            await axios.post(DISCORD_WEBHOOK_URL, {
              content: `🎰 New slot **${slot.msg}** by **${slot.user}**`
            });
            console.log('✅ Discord notified');
          } catch (err) {
            console.error('❌ Discord error:', err);
          }
        }

        // Confirmation reply
        const reply = `your slot '${slot.msg}' has been added to the list ${slot.user}!`;
        console.log('🔍 replying ➜', reply);
        await sendChatReply(page, reply);
      }
    } catch {
      // ignore non-chat frames
    }
  });

  console.log('🚨 Bot is up — listening for commands');
}

// ─── SERVER & API ───────────────────────────────────────────────────
async function startServerAndBot() {
  const client   = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  const db       = client.db();
  const chats    = db.collection('chatMessages');
  const sessions = db.collection('sessions');
  console.log('✅ MongoDB connected');

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), 'public')));

  // SSE endpoint
  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection:      'keep-alive'
    });
    res.write('\n');
    sseClients.push(res);
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
  });

  // Sessions list
  app.get('/api/sessions', async (req, res) => {
    const all = await sessions.find().sort({ startTime: -1 }).toArray();
    res.json(all);
  });

  // Slots list
  app.get('/api/slots', async (req, res) => {
    const filter = {};
    if (req.query.sessionId) filter.sessionId = new ObjectId(req.query.sessionId);
    if (req.query.status)    filter.status    = req.query.status;
    const docs = await chats.find(filter).sort({ time: 1 }).toArray();
    res.json(docs);
  });

  // Delete a slot
  app.delete('/api/slots/:id', async (req, res) => {
    await chats.deleteOne({ _id: new ObjectId(req.params.id) });
    broadcast('delete', { id: req.params.id });
    res.sendStatus(204);
  });

  // Update status/payout
  app.patch('/api/slots/:id', async (req, res) => {
    const { status, payout } = req.body;
    const update = {};
    if (status !== undefined) {
      if (!['IN','OUT'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      update.status = status;
    }
    if (payout !== undefined) {
      const num = parseFloat(payout);
      if (isNaN(num)) {
        return res.status(400).json({ error: 'Invalid payout amount' });
      }
      update.payout = num;
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    await chats.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: update }
    );
    broadcast('update', { id: req.params.id, ...update });
    res.sendStatus(204);
  });

  // Start server
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🖥️ Server listening at http://0.0.0.0:${PORT}`);
  });

  // Launch bot
  startBot(chats, sessions).catch(err => {
    console.error('💥 Bot error:', err);
  });
}

startServerAndBot().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
