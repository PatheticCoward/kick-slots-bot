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

let cachedSettings = null;

// ─── Helpers ───────────────────────────────────────────────────────────────
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
  const sel   = 'div[data-test="chat-input"]';
  const input = await page.waitForSelector(sel, { timeout: 5000 });
  const orig  = await page.evaluate(el => el.innerHTML, input);
  await input.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 25 });
  const btn = await page.$('button[data-test="send"]')
           || await page.$('button[aria-label="Send"]');
  if (btn) await btn.click(); else await page.keyboard.press('Enter');
  await page.waitForFunction(
    (sel, o) => document.querySelector(sel)?.innerHTML === o,
    { polling: 100, timeout: 5000 },
    sel, orig
  );
  console.log('💬 Sent reply:', text);
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
    console.log('🆕 New session:', label);
  } else {
    console.log('🔄 Reusing session:', sess.label);
  }
  return sess;
}

const sseClients = [];
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ─────────────────────────────────────────────────────────────────────────────
async function startServerAndBot() {
  // 1) MongoDB
  const client   = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  const db        = client.db();
  const chats     = db.collection('chatMessages');
  const sessions  = db.collection('sessions');
  const settings  = db.collection('settings');
  console.log('✅ MongoDB connected');

  // 2) Cache settings
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
  await reloadSettings();

  // 3) Express + SSE + static
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
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx > -1) sseClients.splice(idx,1);
    });
  });

  // 4) Settings API
  app.get('/api/settings', (req, res) => res.json(cachedSettings));
  app.patch('/api/settings', async (req, res) => {
    const {
      enabled, subLimit,
      vipLimit, modLimit,
      followerLimit, outCooldownMinutes
    } = req.body;
    const u = {};
    if (enabled            != null) u.enabled            = !!enabled;
    if (subLimit           != null) u.subLimit           = +subLimit;
    if (vipLimit           != null) u.vipLimit           = +vipLimit;
    if (modLimit           != null) u.modLimit           = +modLimit;
    if (followerLimit      != null) u.followerLimit      = +followerLimit;
    if (outCooldownMinutes != null) u.outCooldownMinutes = +outCooldownMinutes;
    await settings.updateOne({}, { $set: u }, { upsert:true });
    await reloadSettings();
    broadcast('settings', cachedSettings);
    res.sendStatus(204);
  });

  // 5) Sessions API
  app.get('/api/sessions', async (req, res) =>
    res.json(await sessions.find().sort({ startTime:-1 }).toArray())
  );

  // 6) Slots API with date‐filter logic
  app.get('/api/slots', async (req, res) => {
    const { sessionId, status, startDate, endDate, user } = req.query;
    console.log('🔍 /api/slots', req.query);

    const filter = {};
    if (sessionId) {
      filter.sessionId = new ObjectId(sessionId);
    } else if (!startDate && !endDate) {
      const curr = await getCurrentSession(sessions);
      filter.sessionId = curr._id;
    }
    if (startDate || endDate) {
      const localCond = {};
      if (startDate) localCond.$gte = startDate;
      if (endDate)   localCond.$lte = endDate;
      let startUtc, endUtc;
      if (startDate) {
        const [y,m,d] = startDate.split('-').map(n=>+n);
        startUtc = new Date(Date.UTC(y,m-1,d,4));
      }
      if (endDate) {
        const [y,m,d] = endDate.split('-').map(n=>+n);
        endUtc = new Date(Date.UTC(y,m-1,d+1,3,59,59,999));
      }
      filter.$or = [
        { localDate: localCond },
        { time: Object.assign({}, startUtc?{ $gte:startUtc }:{}, endUtc?{ $lte:endUtc }:{}) }
      ];
    }
    if (status && status !== 'ALL') filter.status = status;
    else if (!status && !user)      filter.status = { $exists:false };
    if (user) filter.user = user;

    console.log('   → filter:', filter);
    try {
      const data = await chats.find(filter).sort({ time:1 }).toArray();
      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error:'fetch failed' });
    }
  });

 // 7) Update a slot (msg, status or payout only if provided)
app.patch('/api/slots/:id', async (req, res) => {
  try {
    const slotId = new ObjectId(req.params.id);
    const { status, msg, payout } = req.body;

    // Build the update document
    const updateDoc = { statusChangedAt: new Date() };
    if (status    !== undefined) updateDoc.status   = status;
    if (msg       !== undefined) updateDoc.msg      = msg;
    if (payout    !== undefined) updateDoc.payout   = parseFloat(payout);

    // … your limit-check logic here …

    // OUT branch: set cooldown + increment
    if (status === 'OUT') {
      const expiresAt = new Date(Date.now() + cachedSettings.outCooldownMinutes * 60000);
      updateDoc.cooldownExpiresAt = expiresAt;
      await chats.updateOne(
        { _id: slotId },
        { $set: updateDoc, $inc: { outCount: 1 } }
      );
    } else {
      // IN or msg-only edits clear any cooldown
      updateDoc.cooldownExpiresAt = null;
      await chats.updateOne(
        { _id: slotId },
        { $set: updateDoc }
      );
    }

    // Broadcast so the in-out page picks it up
    broadcast('update', { id: req.params.id, status });
    res.sendStatus(204);
  } catch (err) {
    console.error('PATCH /api/slots error', err);
    res.status(500).json({ error: 'Update failed' });
  }
});


  // 8) Delete slot
  app.delete('/api/slots/:id', async (req, res) => {
    await chats.deleteOne({ _id:new ObjectId(req.params.id) });
    broadcast('delete',{ id:req.params.id });
    res.sendStatus(204);
  });

  // 9) Start HTTP
  app.listen(PORT, '0.0.0.0', () =>
    console.log(`🖥️ Server running on http://0.0.0.0:${PORT}`)
  );

  // ─── 10) Kick Bot ─────────────────────────────────────────────────────────
  console.log('🚨 Starting Kick bot…');
  const browser = await puppeteer.launch({ headless:true, args:['--no-sandbox'] });
  const page    = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36'
  );

  try {
    const raw = await fs.readFile('./cookies.json','utf8');
    await page.setCookie(...JSON.parse(raw));
    console.log('🔓 Cookies restored');
  } catch {
    console.log('🔒 No cookies found, will login');
  }

  await page.goto(`https://kick.com/${CHANNEL_SLUG}/chat`, { waitUntil:'networkidle2' });
  await dismissBanner(page);

  const currentSession = await getCurrentSession(sessions);
  let replyQ = Promise.resolve();

  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    let outer;
    try { outer = JSON.parse(response.payloadData); } catch { return; }
    if (!outer.data) return;

    const msg      = typeof outer.data==='string'
                   ? JSON.parse(outer.data)
                   : outer.data;
    const textRaw  = msg.content?.trim();
    if (!textRaw) return;
    const user     = msg.sender.username;
    const textLow  = textRaw.toLowerCase();
    if (user.toLowerCase() === KICK_USERNAME.toLowerCase()) return;

    // ─── !slot ────────────────────────────────────────────────────────────────
    if (textLow.startsWith('!slot ')) {
      const slotText = textRaw.slice(6).trim();
      console.log('🛎️ !slot:', slotText, 'by', user);

      replyQ = replyQ.then(async () => {
        // DUPLICATE CHECK:
        const dup = await chats.findOne({
          sessionId: currentSession._id,
          msg:       slotText
        });
        if (dup) {
          return sendChatReply(page,
            `@${user}: 🎰 ${slotText} has already been called!`
          );
        }

        // otherwise insert new
        const now = new Date();
        const slot = {
          sessionId: currentSession._id,
          time:      now,
          localDate: now.toLocaleDateString('en-CA',{ timeZone:'America/New_York' }),
          user,
          msg:       slotText,
          moderator:  msg.sender.identity?.badges?.some(b=>b.type==='moderator')   || false,
          vip:         msg.sender.identity?.badges?.some(b=>b.type==='vip')         || false,
          subscriber:  msg.sender.identity?.badges?.some(b=>b.type==='subscriber') || false,
          outCount:  0
        };
        const { insertedId } = await chats.insertOne(slot);
        slot._id = insertedId;
        broadcast('slot', slot);

        if (DISCORD_WEBHOOK_URL) {
          await axios.post(DISCORD_WEBHOOK_URL, {
            content: `🎰 New slot **${slotText}** by **${user}**`
          }).catch(console.error);
        }

        return sendChatReply(page,
          `Your 🎰 '${slotText}' has been added to the list @${user}!`
        );
      }).catch(console.error);

      return;
    }

    // ─── !myslots ─────────────────────────────────────────────────────────────
    if (textLow === '!myslots') {
      console.log('🛎️ !myslots by', user);
      replyQ = replyQ.then(async () => {
        const all = await chats.find({
          sessionId: currentSession._id,
          user
        }).sort({ time:1 }).toArray();

        const queued = all.filter(s=>!s.status).map(s=>s.msg);
        const ins    = all.filter(s=>s.status==='IN').map(s=>s.msg);
        const outs   = all.filter(s=>s.status==='OUT').map(s=>s.msg);

        const qText = queued.length ? queued.join(', ') : 'none';
        const iText = ins.length    ? ins.join(', ')    : 'none';
        const oText = outs.length   ? outs.join(', ')   : 'none';

        const reply = `@${user} | 📋: ${qText} | ✅: ${iText} | ❌: ${oText}`;
        return sendChatReply(page, reply);
      }).catch(console.error);
      return;
    }

    // ─── !topD ─────────────────────────────────────────────────────────────
    if (textLow === '!topd') {
      console.log(`🔍 !topD by ${user}`);
      replyQ = replyQ.then(async () => {
        try {
          const now = new Date();
          const st = new Date(now);
          st.setHours(0,0,0,0);
          const sd = st.toISOString().slice(0,10);
          const ed = now.toISOString().slice(0,10);
          const url = `http://localhost:${PORT}/api/slots?status=IN&startDate=${sd}&endDate=${ed}`;
          console.log('Fetching TopD:', url);
          const resp = await axios.get(url);
          const data = resp.data;

          const counts = {};
          data.forEach(s => {
            counts[s.user] = (counts[s.user] || 0) + 1;
          });
          const top5 = Object.entries(counts)
                        .sort((a,b) => b[1] - a[1])
                        .slice(0,5);
          const list = top5.length
            ? top5.map(([u,c]) => `${u}(${c})`).join(', ')
            : 'none';
          const reply = `🏆 Top Daily: ${list}`;
          return sendChatReply(page, reply);

        } catch (err) {
          console.error('!topD error', err);
          return sendChatReply(page,
            `@${user}, could not fetch daily leaderboard.`);
        }
      }).catch(console.error);
      return;
    }

    // ─── !topW ─────────────────────────────────────────────────────────────
    if (textLow === '!topw') {
      console.log(`🔍 !topW by ${user}`);
      replyQ = replyQ.then(async () => {
        try {
          const now = new Date();
          const st = new Date(now);
          st.setDate(now.getDate() - 6);
          st.setHours(0,0,0,0);
          const sd = st.toISOString().slice(0,10);
          const ed = now.toISOString().slice(0,10);
          const url = `http://localhost:${PORT}/api/slots?status=IN&startDate=${sd}&endDate=${ed}`;
          console.log('Fetching TopW:', url);
          const resp = await axios.get(url);
          const data = resp.data;

          const counts = {};
          data.forEach(s => {
            counts[s.user] = (counts[s.user] || 0) + 1;
          });
          const top5 = Object.entries(counts)
                        .sort((a,b) => b[1] - a[1])
                        .slice(0,5);
          const list = top5.length
            ? top5.map(([u,c]) => `${u}(${c})`).join(', ')
            : 'none';
          const reply = `🏆 Top Weekly: ${list}`;
          return sendChatReply(page, reply);

        } catch (err) {
          console.error('!topW error', err);
          return sendChatReply(page,
            `@${user}, could not fetch weekly leaderboard.`);
        }
      }).catch(console.error);
      return;
    }

    // ─── !topM ─────────────────────────────────────────────────────────────
    if (textLow === '!topm') {
      console.log(`🔍 !topM by ${user}`);
      replyQ = replyQ.then(async () => {
        try {
          const now = new Date();
          const st = new Date(now);
          st.setDate(now.getDate() - 29);
          st.setHours(0,0,0,0);
          const sd = st.toISOString().slice(0,10);
          const ed = now.toISOString().slice(0,10);
          const url = `http://localhost:${PORT}/api/slots?status=IN&startDate=${sd}&endDate=${ed}`;
          console.log('Fetching TopM:', url);
          const resp = await axios.get(url);
          const data = resp.data;

          const counts = {};
          data.forEach(s => {
            counts[s.user] = (counts[s.user] || 0) + 1;
          });
          const top5 = Object.entries(counts)
                        .sort((a,b) => b[1] - a[1])
                        .slice(0,5);
          const list = top5.length
            ? top5.map(([u,c]) => `${u}(${c})`).join(', ')
            : 'none';
          const reply = `🏆 Top Monthly: ${list}`;
          return sendChatReply(page, reply);

        } catch (err) {
          console.error('!topM error', err);
          return sendChatReply(page,
            `@${user}, could not fetch monthly leaderboard.`);
        }
      }).catch(console.error);
      return;
    }

    // … any other commands …

  });
}

startServerAndBot().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});