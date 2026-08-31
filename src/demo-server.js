import http from 'node:http';
import path from 'node:path';
import { ActivityStore } from './activity-store.js';
import { CustomCommandsStore } from './custom-commands-store.js';
import { createLogger } from './logger.js';
import { LoyaltyStore } from './loyalty-store.js';
import { StreamBotEngine } from './stream-bot-engine.js';

const host = process.env.HOST || '127.0.0.1';
const port = Math.max(1, Math.min(65535, Number(process.env.PORT) || 3000));
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || '.data/demo');
const logger = createLogger('demo');

const commandStore = new CustomCommandsStore({ storePath: path.join(dataDir, 'commands.json'), logger });
const activityStore = new ActivityStore({ storePath: path.join(dataDir, 'activity.json'), logger });
const loyaltyStore = new LoyaltyStore({ storePath: path.join(dataDir, 'loyalty.json'), logger });
commandStore.load();
activityStore.load();
loyaltyStore.load();
seedCommands(commandStore);

const chat = [
  { kind: 'system', user: 'StreamBot', text: 'Local demo is ready. Try !hello, !roll, !points, or !top.' },
  { kind: 'viewer', user: 'northstar', text: '!hello' },
  { kind: 'bot', user: 'StreamBot', text: 'Hello, northstar! Welcome to the stream.' }
];

const engine = new StreamBotEngine({
  channel: 'streamer',
  commandStore,
  activityStore,
  loyaltyStore,
  pointsPerMessage: 2,
  sendMessage: async (message) => {
    chat.push({ kind: 'bot', user: 'StreamBot', text: message });
    trimChat();
  },
  logger
});

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/') {
    sendHtml(response, PAGE);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { ok: true, uptimeSec: Math.round(process.uptime()) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    sendJson(response, 200, status());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/simulate') {
    try {
      const body = await readJson(request);
      const login = normalizeLogin(body.login) || 'viewer';
      const name = normalizeName(body.name) || login;
      const message = String(body.message || '').trim().slice(0, 500);
      const role = ['viewer', 'subscriber', 'vip', 'moderator', 'broadcaster'].includes(body.role)
        ? body.role
        : 'viewer';
      if (!message) {
        sendJson(response, 400, { error: 'Message is required.' });
        return;
      }

      chat.push({ kind: 'viewer', user: name, text: message });
      trimChat();
      const result = await engine.handleMessage({
        chatter_user_id: `demo:${login}`,
        chatter_user_login: role === 'broadcaster' ? 'streamer' : login,
        chatter_user_name: role === 'broadcaster' ? 'Streamer' : name,
        badges: badgesForRole(role),
        message: { text: message }
      });
      activityStore.flush();
      sendJson(response, 200, { result, status: status() });
    } catch (error) {
      const statusCode = error.code === 'BODY_TOO_LARGE' ? 413 : 400;
      sendJson(response, statusCode, { error: error.message });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

server.listen(port, host, () => {
  logger.info(`Demo dashboard: http://${host}:${port}`);
});

function status() {
  const stats = activityStore.statsByDays(7, 5);
  return {
    connected: true,
    mode: 'local demo',
    channel: 'streamer',
    commands: commandStore.list().map(({ name, type, minRole, aliases }) => ({
      name,
      type,
      minRole,
      aliases
    })),
    activity: stats,
    chat: chat.slice(-20)
  };
}

function seedCommands(store) {
  if (store.list().length > 0) return;
  store.upsert({
    name: 'hello',
    aliases: ['hi'],
    type: 'text',
    minRole: 'everyone',
    config: { response: 'Hello, {user}! Welcome to the stream.' }
  });
  store.upsert({
    name: 'roll',
    type: 'text',
    minRole: 'everyone',
    config: { response: '🎲 {user} rolled {random:1-100}.' }
  });
  store.upsert({
    name: 'wins',
    type: 'counter',
    minRole: 'moderator',
    config: { template: '🏆 Stream wins: {count}', value: 12 }
  });
}

function badgesForRole(role) {
  if (role === 'broadcaster') return [{ set_id: 'broadcaster', id: '1' }];
  if (role === 'moderator') return [{ set_id: 'moderator', id: '1' }];
  if (role === 'vip') return [{ set_id: 'vip', id: '1' }];
  if (role === 'subscriber') return [{ set_id: 'subscriber', id: '1' }];
  return [];
}

function normalizeLogin(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25);
}

function normalizeName(value) {
  return String(value || '').replace(/[\r\n<>]/g, '').trim().slice(0, 40);
}

function trimChat() {
  if (chat.length > 50) chat.splice(0, chat.length - 50);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) {
      const error = new Error('Request body is too large.');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
  );
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sendHtml(response, html) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Razex Stream Bot · Local Demo</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#08090d;color:#f7f7fb}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 0,rgba(145,71,255,.2),transparent 34rem),radial-gradient(circle at 90% 96%,rgba(34,197,94,.08),transparent 30rem),#08090d}
    main{width:min(1180px,calc(100vw - 48px));margin:0 auto;padding:34px 0 48px}.top{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:25px}.brand{display:flex;align-items:center;gap:15px}.logo{display:grid;place-items:center;width:50px;height:50px;border:1px solid #7c4dd4;border-radius:15px;background:linear-gradient(135deg,#9147ff,#5b21b6);box-shadow:0 18px 48px rgba(145,71,255,.25);font-size:22px}h1{margin:0 0 3px;font-size:25px;letter-spacing:-.035em}.muted{color:#918b9e}.subtitle{margin:0;font-size:13px}.status{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid rgba(74,222,128,.25);border-radius:999px;background:rgba(34,197,94,.08);color:#86efac;font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}.status:before{content:"";width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 15px #4ade80}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:15px}.stat,.panel{border:1px solid #282631;background:rgba(16,16,22,.9);box-shadow:0 20px 70px rgba(0,0,0,.18)}.stat{padding:17px;border-radius:14px}.stat strong{display:block;margin-bottom:5px;font-size:24px}.stat span{font-size:12px;color:#8f899b}.grid{display:grid;grid-template-columns:1.08fr .92fr;gap:15px}.panel{overflow:hidden;border-radius:17px}.panel-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #282631}.panel-head h2{margin:0;font-size:14px}.tag{padding:5px 8px;border-radius:8px;background:#211a2e;color:#c4b5fd;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}.chat{height:370px;overflow:auto;padding:18px}.message{display:grid;grid-template-columns:76px 1fr;gap:11px;margin-bottom:15px;font-size:14px}.who{font-weight:750;color:#b78cff}.bot .who{color:#86efac}.system .who{color:#fbbf24}.text{color:#d8d5df}.composer{display:grid;grid-template-columns:110px 120px 1fr auto;gap:8px;padding:13px;border-top:1px solid #282631;background:#0d0d12}input,select,button{height:39px;border:1px solid #302d3a;border-radius:10px;background:#131219;color:#eee;padding:0 11px;font:inherit}input:focus,select:focus{outline:2px solid rgba(145,71,255,.45);border-color:#9147ff}button{border:0;background:linear-gradient(135deg,#9147ff,#7440da);font-weight:750;cursor:pointer;padding:0 18px}.side{display:grid;gap:15px}.architecture{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:7px;padding:18px}.node{padding:14px 8px;border:1px solid #2b2834;border-radius:12px;background:#111017;text-align:center;font-size:12px;color:#aaa5b3}.node strong{display:block;margin-bottom:4px;color:#f3f1f7;font-size:13px}.arrow{color:#686171}.commands{padding:9px 18px 17px}.command{display:grid;grid-template-columns:1fr 85px 100px;gap:8px;align-items:center;padding:12px 0;border-bottom:1px solid #24212b;font-size:13px}.command:last-child{border:0}.command code{color:#c4b5fd;font-weight:700}.pill{justify-self:start;padding:4px 7px;border-radius:7px;background:#191721;color:#9e98a9;font-size:10px}.footer-note{padding:16px 18px;border-top:1px solid #282631;color:#8e8899;font-size:12px;line-height:1.55}
    @media(max-width:850px){.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.composer{grid-template-columns:1fr 1fr}.composer input{grid-column:1/-1}.top{align-items:flex-start}.status{display:none}}
  </style>
</head>
<body>
<main>
  <header class="top"><div class="brand"><div class="logo">⚡</div><div><h1>Razex Stream Bot</h1><p class="subtitle muted">Dependency-free Twitch automation core · local interactive demo</p></div></div><div class="status">LOCAL DEMO ONLINE</div></header>
  <section class="stats"><div class="stat"><strong id="commandsCount">—</strong><span>custom commands</span></div><div class="stat"><strong id="messagesCount">—</strong><span>messages tracked</span></div><div class="stat"><strong id="viewersCount">—</strong><span>active viewers</span></div><div class="stat"><strong>0</strong><span>production secrets</span></div></section>
  <div class="grid">
    <section class="panel"><div class="panel-head"><h2>Chat simulator</h2><span class="tag">SAME COMMAND ENGINE</span></div><div id="chat" class="chat"></div><form id="composer" class="composer"><input id="name" value="viewer" aria-label="Display name"><select id="role" aria-label="Role"><option value="viewer">Viewer</option><option value="subscriber">Subscriber</option><option value="vip">VIP</option><option value="moderator">Moderator</option><option value="broadcaster">Broadcaster</option></select><input id="message" value="!roll" aria-label="Chat message" autocomplete="off"><button>Send</button></form></section>
    <aside class="side">
      <section class="panel"><div class="panel-head"><h2>Runtime flow</h2><span class="tag">NODE.JS 22</span></div><div class="architecture"><div class="node"><strong>Twitch IRC</strong>TLS transport</div><div class="arrow">→</div><div class="node"><strong>Bot engine</strong>roles + cooldowns</div><div class="arrow">→</div><div class="node"><strong>Core stores</strong>atomic JSON</div></div><div class="footer-note">The public core contains no billing, customer provisioning, production topology, or owner administration.</div></section>
      <section class="panel"><div class="panel-head"><h2>Available commands</h2><span class="tag">LIVE CONFIG</span></div><div id="commands" class="commands"></div></section>
    </aside>
  </div>
</main>
<script>
  var chat = document.getElementById('chat');
  function esc(value){return String(value||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function render(data){
    document.getElementById('commandsCount').textContent=data.commands.length;
    document.getElementById('messagesCount').textContent=data.activity.totals.messages||0;
    document.getElementById('viewersCount').textContent=data.activity.totals.activeUsers||0;
    chat.innerHTML=data.chat.map(function(m){return '<div class="message '+esc(m.kind)+'"><span class="who">'+esc(m.user)+'</span><span class="text">'+esc(m.text)+'</span></div>';}).join('');
    chat.scrollTop=chat.scrollHeight;
    document.getElementById('commands').innerHTML=data.commands.map(function(c){return '<div class="command"><code>!'+esc(c.name)+'</code><span class="pill">'+esc(c.type)+'</span><span class="pill">'+esc(c.minRole)+'</span></div>';}).join('')+'<div class="command"><code>!points</code><span class="pill">built-in</span><span class="pill">everyone</span></div><div class="command"><code>!top</code><span class="pill">built-in</span><span class="pill">everyone</span></div>';
  }
  async function load(){var r=await fetch('/api/status');render(await r.json());}
  document.getElementById('composer').addEventListener('submit',async function(e){e.preventDefault();var payload={name:document.getElementById('name').value,login:document.getElementById('name').value,role:document.getElementById('role').value,message:document.getElementById('message').value};var r=await fetch('/api/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});var d=await r.json();if(d.status)render(d.status);});
  load();
</script>
</body>
</html>`;
