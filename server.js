import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createServices, AppError, DELIVERY } from './services.js';
import { getProvider } from './providers.js';
import { makeChat } from './chat.js';

try { process.loadEnvFile('.env'); } catch { /* env may come from the host */ }

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'); // random per boot if unset

export function buildApp(env = process.env, dbPath) {
  const db = openDb(dbPath);
  const provider = getProvider(env);
  const svc = createServices(db, provider);
  svc.seedMerchant(env.ADMIN_EMAIL || 'amaka@example.com', env.ADMIN_PASSWORD);
  const chat = makeChat(svc);
  const hits = new Map();
  const limited = (ip, key, max) => { // simple fixed-window rate limit
    const k = key + ip, now = Date.now(), h = hits.get(k);
    if (!h || h.reset < now) { hits.set(k, { n: 1, reset: now + 60000 }); return false; }
    return ++h.n > max;
  };
  setInterval(() => { for (const [k, h] of hits) if (h.reset < Date.now()) hits.delete(k); }, 60000).unref();
  const sweeper = setInterval(() => svc.sweepExpired().catch((e) => console.error('sweep', e.message)), 30000); sweeper.unref();

  const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, v.join('=')]));
  const isAdmin = (req) => { const c = cookies(req).adm; if (!c) return null; const [exp, sig] = c.split('.'); return exp && sig === sign(exp) && Number(exp) > Date.now() ? 'amaka' : null; };

  async function readBody(req, limit = 1e6) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > limit) throw new AppError('Body too large', 413); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const send = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
    try {
      if (!url.pathname.startsWith('/api/')) { // static
        let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html' : url.pathname));
        if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(f));
      }
      if (limited(ip, 'all', 300)) throw new AppError('Too many requests', 429);
      const route = url.pathname.replace(/^\/api/, '');

      // webhook: raw bytes preserved for signature verification, no session/CSRF involved (HMAC authenticates)
      if (req.method === 'POST' && route === '/webhooks/busha') {
        if (provider.mode !== 'busha') return send(404, { error: 'not found' });
        const r = await svc.handleWebhook(await readBody(req), req.headers);
        return send(r.status, r.body);
      }

      // CSRF guard: state-changing requests must be JSON (cross-site forms cannot send application/json without preflight)
      let body = {};
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] || '').includes('application/json')) throw new AppError('JSON required', 415);
        const raw = await readBody(req); body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      }
      const sid = svc.ensureSession(cookies(req).sid);
      const setSid = { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}` };
      const ok = (obj) => send(200, obj, setSid);
      let m;

      // ---- admin ----
      if (route.startsWith('/admin/')) {
        if (route === '/admin/login' && req.method === 'POST') {
          if (limited(ip, 'login', 8)) throw new AppError('Too many attempts', 429);
          if (!svc.merchantLogin(body.email, body.password)) throw new AppError('Invalid credentials', 401);
          const exp = String(Date.now() + 8 * 3600e3);
          return send(200, { ok: true }, { 'Set-Cookie': `adm=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}` });
        }
        const actor = isAdmin(req); if (!actor) throw new AppError('Merchant login required', 401);
        if (route === '/admin/logout') return send(200, { ok: true }, { 'Set-Cookie': 'adm=; Path=/; Max-Age=0' });
        if (route === '/admin/orders') return send(200, { orders: svc.adminOrders({ payment: url.searchParams.get('payment'), fulfilment: url.searchParams.get('fulfilment') }) });
        if ((m = route.match(/^\/admin\/orders\/(\d+)$/))) return send(200, svc.adminOrder(+m[1]));
        if ((m = route.match(/^\/admin\/orders\/(\d+)\/pack$/))) return send(200, svc.pack(+m[1], actor));
        if ((m = route.match(/^\/admin\/orders\/(\d+)\/dispatch$/))) return send(200, svc.dispatch(+m[1], body.courier, body.tracking, actor));
        if ((m = route.match(/^\/admin\/orders\/(\d+)\/delivery-fee$/))) return send(200, svc.setDeliveryFee(+m[1], body.kobo, actor));
        if (route === '/admin/reviews') return send(200, { reviews: svc.reviewsList() });
        if ((m = route.match(/^\/admin\/reviews\/(\d+)\/resolve$/))) return send(200, svc.resolveReview(+m[1], actor));
        if (route === '/admin/variants') return send(200, { variants: svc.adminVariants() });
        if ((m = route.match(/^\/admin\/variants\/(\d+)\/stock$/))) return send(200, svc.setStock(+m[1], body.stock, actor));
        if (route === '/admin/mock/simulate') return send(200, await svc.simulate(+body.attemptId, body.scenario, actor)); // 404 unless mock mode
        throw new AppError('Not found', 404);
      }

      // ---- customer ----
      if (route === '/config') return ok({ mode: provider.mode, banner: provider.label, capabilities: provider.capabilities(), delivery: DELIVERY, madeBy: 'Team Gritten' });
      if (route === '/products') return ok({ products: svc.listProducts() });
      if (route === '/cart' && req.method === 'GET') return ok(svc.cartGet(sid));
      if (route === '/cart' && req.method === 'POST') return ok(body.delta !== undefined ? svc.cartAdd(sid, +body.variantId, +body.delta) : svc.cartSet(sid, +body.variantId, +body.qty));
      if (route === '/checkout' && req.method === 'POST') { if (limited(ip, 'co', 20)) throw new AppError('Too many requests', 429); return ok(svc.checkout(sid, body)); }
      if (route === '/orders') return ok({ orders: svc.sessionOrders(sid) });
      if (route === '/chat' && req.method === 'POST') { if (limited(ip, 'chat', 120)) throw new AppError('Too many requests', 429); return ok(await chat(sid, body.action, body.args || {})); }
      if ((m = route.match(/^\/orders\/([\w-]+)(?:\/(pay|refresh|cancel))?$/))) {
        const [, token, act] = m;
        if (!act) return ok(svc.orderByTokenView(token));
        if (act === 'pay') { if (limited(ip, 'pay', 10)) throw new AppError('Too many payment requests, wait a minute', 429); return ok(await svc.createPayment(token, body.method)); }
        if (act === 'refresh') { if (limited(ip, 'rf' + token, 20)) return ok(svc.orderByTokenView(token)); return ok(await svc.refreshOrder(token)); }
        if (act === 'cancel') return ok(svc.cancelOrder(sid, token));
      }
      throw new AppError('Not found', 404);
    } catch (e) {
      if (e instanceof AppError) return send(e.status, { error: e.message });
      if (e instanceof SyntaxError) return send(400, { error: 'Bad JSON' });
      console.error('Unhandled:', e.message);
      send(500, { error: 'Internal error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.PAYMENT_MODE === 'busha' && !process.env.BUSHA_SECRET_KEY) console.warn('PAYMENT_MODE=busha but BUSHA_SECRET_KEY missing: payments will show "setup required".');
  if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD not set: merchant login disabled until a merchant exists.');
  const port = Number(process.env.PORT || 3000);
  buildApp().listen(port, () => console.log(`Amaka's Closet on :${port} [${process.env.PAYMENT_MODE || 'mock'} mode]`));
}
