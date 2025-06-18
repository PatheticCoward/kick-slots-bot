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

if (!KICK_USERNAME)   throw new Error('Missing KICK_USERNAME in .env');
if (!KICK_PASSWORD)   throw new Error('Missing KICK_PASSWORD in .env');
if (!MONGODB_URI)     throw new Error('Missing MONGODB_URI in .env');
if (!CHANNEL_SLUG)    throw new Error('Missing CHANNEL_SLUG in .env');

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── In-process cache for settings ─────────────────────────────────────────
let cachedSettings = null;

// ─── Helpers ────────────────────────────────────────────────────────────────
async function dismissBanner(page) {
  for (const txt of ['Accept','Reject']) {
    try {
      const [btn] = await page.$x(`//button[normalize-space()="${txt}"]`);
      if (btn) { await btn.click(); await delay(500); }
    } catch {}
  }
}

async function sendChatReply(page, text) {
  await dismissBanner(page);
  const selector = 'div[data-test="chat-input"]';
  const input    = await page.waitForSelector(selector, { timeout: 5000 });
  const original = await page.evaluate(el => el.innerHTML, input);

  await input.focus();
  await delay(50);

  // clear existing
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await delay(25);

  // type reply
  await page.keyboard.type(text, { delay: 25 });

  // send
  const sendBtn = await page.$('button[data-test="send"]')
                || await page.$('button[aria-label="Send"]');
  if (sendBtn) await sendBtn.click();
  else          await page.keyboard.press('Enter');

  // wait until cleared
  await page.waitForFunction(
    (sel, orig) => document.querySelector(sel)?.innerHTML === orig,
    { polling: 100, timeout: 5000 },
    selector, original
  );
  console.log('💬 Sent confirmation reply:', text);
}

async function getCurrentSession(sessions, timeoutMs = 2*60*60*1000) {
  const now = new Date();
  let sess = await sessions.find().sort({ lastActivity:-1 }).limit(1).next();
  if (!sess || now - new Date(sess.lastActivity) > timeoutMs) {
    const label = now.toISOString().slice(0,16).replace('T',' ');
    const { insertedId } = await sessions.insertOne({
      startTime: now,
      lastActivity: now,
      label
    });
    sess = { _id: insertedId, startTime: now, lastActivity: now, label };
    console.log('🆕 Created new session:', label);
  } else {
    console.log('🔄 Reusing session:', sess.label);
  }
  return sess;
}

// SSE clients
const sseClients = [];
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function startServerAndBot() {
  // 1) Connect to MongoDB
  const client   = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  const db        = client.db();
  const chats     = db.collection('chatMessages');
  const sessions  = db.collection('sessions');
  const settings  = db.collection('settings');
  const timeouts  = db.collection('timeouts');
  console.log('✅ MongoDB connected');

  // ─── Cache loader ─────────────────────────────────────────────────────────
  async function reloadSettings() {
    const cfg = await settings.findOne({});
    cachedSettings = cfg || {
      enabled: false,
      subLimit: 1,
      vipLimit: 1,
      modLimit: 1,
      followerLimit: 1,
      outCooldownMinutes: 10
    };
  }
  // prime cache
  await reloadSettings();

  // 2) Express + SSE
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(),'public')));

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection:      'keep-alive'
    });
    res.write('\n');
    sseClients.push(res);
    req.on('close', ()=> {
      const idx = sseClients.indexOf(res);
      if (idx!==-1) sseClients.splice(idx,1);
    });
  });

  // 3) Settings
  app.get('/api/settings', (req, res) => {
    res.json(cachedSettings);
  });

  app.patch('/api/settings', async (req, res) => {
    const { enabled, subLimit, vipLimit, modLimit, followerLimit, outCooldownMinutes } = req.body;
    const u = {};
    if (enabled           != null) u.enabled            = !!enabled;
    if (subLimit          != null) u.subLimit           = parseInt(subLimit,10);
    if (vipLimit          != null) u.vipLimit           = parseInt(vipLimit,10);
    if (modLimit          != null) u.modLimit           = parseInt(modLimit,10);
    if (followerLimit     != null) u.followerLimit      = parseInt(followerLimit,10);
    if (outCooldownMinutes!= null) u.outCooldownMinutes = parseFloat(outCooldownMinutes);
    await settings.updateOne({}, { $set: u }, { upsert:true });

    // refresh cache
    await reloadSettings();

    broadcast('settings', cachedSettings);
    res.sendStatus(204);
  });

  // 4) Timeouts endpoints
  app.get('/api/timeouts', async (req, res) => {
    const arr = await timeouts.find().sort({ expiresAt:1 }).toArray();
    res.json(arr);
  });
  app.post('/api/timeouts', async (req, res) => {
    const { user, duration } = req.body;
    if (!user || !duration || duration<=0) {
      return res.status(400).json({ error:'Invalid user or duration' });
    }
    const expiresAt = new Date(Date.now()+duration*60000);
    const { insertedId } = await timeouts.insertOne({ user, expiresAt });
    const to = { _id: insertedId, user, expiresAt };
    broadcast('timeoutAdd', to);
    res.status(201).json(to);
  });
  app.delete('/api/timeouts/:id', async (req, res) => {
    await timeouts.deleteOne({ _id: new ObjectId(req.params.id) });
    broadcast('timeoutRemove', { id: req.params.id });
    res.sendStatus(204);
  });

  // 5) Sessions
  app.get('/api/sessions', async (req, res) => {
    const all = await sessions.find().sort({ startTime:-1 }).toArray();
    res.json(all);
  });

  // 6) Slots listing
  app.get('/api/slots', async (req, res) => {
    const { sessionId, status, startDate, endDate } = req.query;
    const filter = {};
    if (sessionId) {
      filter.sessionId = new ObjectId(sessionId);
    } else if (!startDate && !endDate) {
      const curr = await getCurrentSession(sessions);
      filter.sessionId = curr._id;
    }
    if (startDate || endDate) {
      filter.time = {};
      if (startDate) filter.time.$gte = new Date(startDate);
      if (endDate) {
        const d = new Date(endDate);
        d.setDate(d.getDate()+1);
        d.setMilliseconds(d.getMilliseconds()-1);
        filter.time.$lte = d;
      }
    }
    if (status && status!=='ALL') filter.status = status;
    else if (!status) filter.status = { $exists:false };
// console.logs removed for filter
    try {
      const docs = await chats.find(filter).sort({ time:1 }).toArray();
      res.json(docs);
    } catch(e) {
      console.error(e);
      res.status(500).json({ error:'Fetch failed' });
    }
  });

  // 7) Update slot — now using cachedSettings
  app.patch('/api/slots/:id', async (req, res) => {
    try {
      const slotId = new ObjectId(req.params.id);
      const { status, msg, payout } = req.body;

      // Build update document
      const updateDoc = {
        status,
        statusChangedAt: new Date()
      };
      if (msg !== undefined)    updateDoc.msg    = msg;
      if (payout !== undefined) updateDoc.payout = parseFloat(payout);

      // Enforce limits on IN using cache
      if (status === 'IN' && cachedSettings.enabled) {
        const slotDoc = await chats.findOne({ _id: slotId });
        if (slotDoc) {
          let limit = cachedSettings.followerLimit;
          if (slotDoc.moderator)      limit = cachedSettings.modLimit;
          else if (slotDoc.vip)        limit = cachedSettings.vipLimit;
          else if (slotDoc.subscriber) limit = cachedSettings.subLimit;
          const calledCount = await chats.countDocuments({
            sessionId: slotDoc.sessionId,
            user:      slotDoc.user
          });
          if (calledCount >= limit) {
            return res
              .status(400)
              .json({ error: `Slot limit of ${limit} reached for user ${slotDoc.user}` });
          }
        }
      }

      if (status === 'OUT') {
        const cooldownMinutes = cachedSettings.outCooldownMinutes;
        const expiresAt = new Date(Date.now() + cooldownMinutes * 60000);
        updateDoc.cooldownExpiresAt = expiresAt;
        await chats.updateOne(
          { _id: slotId },
          { $set: updateDoc, $inc: { outCount: 1 } }
        );
      } else {
        updateDoc.cooldownExpiresAt = null;
        await chats.updateOne(
          { _id: slotId },
          { $set: updateDoc }
        );
      }

      broadcast('update', { id: req.params.id, status });
      res.sendStatus(204);
    } catch (err) {
      console.error('PATCH /api/slots error', err);
      res.status(500).json({ error: 'Update failed' });
    }
  });

  // 8) Delete slot
  app.delete('/api/slots/:id', async (req, res) => {
    await chats.deleteOne({ _id: new ObjectId(req.params.id) });
    broadcast('delete', { id: req.params.id });
    res.sendStatus(204);
  });

  // 9) Start server
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🖥️ Server listening at http://0.0.0.0:${PORT}`);
  });

  // 10) Puppeteer Bot
  console.log('🚨 Starting Kick bot…');
  (async () => {
    const currentSession = await getCurrentSession(sessions);
    let replyQ = Promise.resolve();

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
      const raw = await fs.readFile('./cookies.json','utf8');
      await page.setCookie(...JSON.parse(raw));
      console.log('🔓 Restored session cookies');
    } catch {
      console.log('🔒 No cookies.json found; manual login needed');
    }

    // login flow...
    console.log('🌐 Navigating to kick.com');
    await page.goto('https://kick.com',{ waitUntil:'networkidle2' });
    await dismissBanner(page);
    const loginBtns = await page.$$('button[data-test="login"]');
    if (loginBtns.length >= 2) {
      const [acceptBtn] = await page.$x("//button[normalize-space()='Accept']");
      if (acceptBtn) { await acceptBtn.click(); await delay(500); }
      await loginBtns[1].click();
      await page.waitForSelector('div[role="dialog"] input',{timeout:60000});
      const inputs = await page.$$('div[role="dialog"] input');
      await inputs[0].type(KICK_USERNAME,{delay:50});
      await inputs[1].type(KICK_PASSWORD,{delay:50});
      await Promise.all([
        page.waitForNavigation({waitUntil:'networkidle2',timeout:60000}),
        page.click('div[role="dialog"] button[type="submit"]')
      ]);
      console.log('🔑 Waiting for 2FA… 60s');
      await delay(60000);
      const fresh = await page.cookies();
      await fs.writeFile('./cookies.json', JSON.stringify(fresh,null,2));
      console.log('🔒 Saved session cookies');
    } else {
      console.log('✅ Already logged in via cookies');
    }

    // go to chat
    const chatURL = `https://kick.com/${CHANNEL_SLUG}/chat`;
    console.log(`🎯 Navigating to chat: ${chatURL}`);
    await page.goto(chatURL,{waitUntil:'networkidle2'});
    await dismissBanner(page);

    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameReceived', ({ response }) => {
      let outer;
      try { outer = JSON.parse(response.payloadData); } catch { return; }
      if (!outer.data) return;
      let msg = typeof outer.data === 'string'
             ? JSON.parse(outer.data)
             : outer.data;
      const text = msg.content?.trim();
      if (!text) return;
      const user = msg.sender.username;

      // ---- !slot command ----
      if (text.startsWith('!slot ')) {
        const slotText = text.slice(6).trim();
        console.log('🛎️ Received slot:', slotText, 'from', user);

        replyQ = replyQ.then(async () => {
          // 1) Timeout check
          const to = await timeouts.find({ user }).sort({ expiresAt: -1 }).limit(1).next();
          if (to && new Date(to.expiresAt) > new Date()) {
            const mins = Math.ceil((new Date(to.expiresAt) - Date.now()) / 60000);
            return sendChatReply(page,
              `@${user}, you are timed out for ${mins} more minute${mins > 1 ? 's' : ''}.`
            );
          }

          // 2) SLOT LIMITS check using cache
          if (cachedSettings.enabled) {
            const badges = msg.sender.identity.badges || [];
            let limit = cachedSettings.followerLimit;
            if (badges.some(b => b.type === 'moderator'))      limit = cachedSettings.modLimit;
            else if (badges.some(b => b.type === 'vip'))        limit = cachedSettings.vipLimit;
            else if (badges.some(b => b.type === 'subscriber')) limit = cachedSettings.subLimit;

            const calledCount = await chats.countDocuments({
              sessionId:  currentSession._id,
              user
            });
            if (calledCount >= limit) {
              return sendChatReply(page,
                `@${user}, you have reached your slot limit of ${limit}.`
              );
            }
          }

          // 3) Duplicate & cooldown...
          const existing = await chats.findOne({ sessionId: currentSession._id, msg: slotText }, { sort: { time: -1 } });
          if (existing) {
            if (existing.status === 'OUT') {
              const now = Date.now(), exp = new Date(existing.cooldownExpiresAt).getTime();
              if (exp > now) {
                const mins = Math.ceil((exp - now) / 60000);
                return sendChatReply(page,
                  `This slot is on cooldown for the next ${mins} minutes.`
                );
              }
            } else {
              return sendChatReply(page,
                `@${user}, this slot has already been called.`
              );
            }
          }

          // 4) Insert new slot...
          const badges = msg.sender.identity.badges || [];
          const slot = {
            sessionId:  currentSession._id,
            time:       new Date(),
            user,
            msg:        slotText,
            subscriber: badges.some(b => b.type === 'subscriber'),
            vip:        badges.some(b => b.type === 'vip'),
            moderator:  badges.some(b => b.type === 'moderator'),
            outCount:   0
          };
          const { insertedId } = await chats.insertOne(slot);
          slot._id = insertedId;
          broadcast('slot', slot);

          // discord webhook
          if (DISCORD_WEBHOOK_URL) {
            axios.post(DISCORD_WEBHOOK_URL, { content: `🎰 New slot **${slotText}** by **${user}**` }).catch(console.error);
          }

          // 5) confirmation
          return sendChatReply(page,
            `Your 🎰 '${slotText}' has been added to the list @${user}!`
          );
        }).catch(console.error);
      }

      // handle other commands...
    });
  })();
}

startServerAndBot().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
