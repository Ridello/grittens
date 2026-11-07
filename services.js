import crypto from 'node:crypto';
import { toUnits, fromUnits } from './money.js';

export class AppError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const DELIVERY = {
  pickup: { label: 'Pickup (Ibadan)', fee: 0 },
  ibadan: { label: 'Local delivery, Ibadan (DEMO rate)', fee: 150000 },
  other: { label: 'Other destination (manual quote by Amaka)', fee: null },
};
const BLOCKING = ['overpayment', 'receipt_mismatch'];
const iso = () => new Date().toISOString();
const plusMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const pad = (n) => String(n).padStart(5, '0');

export function createServices(db, provider, opts = {}) {
  const reserveMin = opts.reserveMin ?? 30;
  let depth = 0;
  function tx(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { depth--; }
  }
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const audit = (actor, action, detail) => run('INSERT INTO audit_log(actor,action,detail,created_at) VALUES(?,?,?,?)', actor, action, typeof detail === 'string' ? detail : JSON.stringify(detail), iso());
  const event = (orderId, text) => run('INSERT INTO order_events(order_id,text,notify,created_at) VALUES(?,?,1,?)', orderId, text, iso());
  const AVAIL = `v.stock - COALESCE((SELECT SUM(r.qty) FROM reservations r WHERE r.variant_id=v.id AND r.state='HELD'),0)`;
  const sumReceipts = (attemptId) => all('SELECT amount_units FROM receipts WHERE attempt_id=?', attemptId).reduce((s, r) => s + BigInt(r.amount_units), 0n);

  function ensureSession(sid) {
    if (sid && one('SELECT id FROM sessions WHERE id=?', sid)) return sid;
    const id = crypto.randomBytes(24).toString('base64url');
    run('INSERT INTO sessions(id,created_at) VALUES(?,?)', id, iso());
    return id;
  }

  // ---------------- catalogue & cart ----------------
  function listProducts(search) {
    const rows = all(`SELECT p.id pid,p.name,p.description,p.price_kobo,p.hue,v.id vid,v.size,v.colour,${AVAIL} available FROM products p JOIN variants v ON v.product_id=p.id ORDER BY p.id,v.id`);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.pid)) map.set(r.pid, { id: r.pid, name: r.name, description: r.description, price_kobo: r.price_kobo, hue: r.hue, variants: [] });
      map.get(r.pid).variants.push({ id: r.vid, size: r.size, colour: r.colour, available: r.available });
    }
    let out = [...map.values()];
    if (search) out = out.filter((p) => p.name.toLowerCase().includes(String(search).toLowerCase()));
    return out;
  }
  function cartGet(sid) {
    const items = all(`SELECT c.variant_id,c.qty,p.name,p.price_kobo,p.hue,v.size,v.colour,${AVAIL} available FROM cart_items c JOIN variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id WHERE c.session_id=? ORDER BY c.rowid`, sid)
      .map((i) => ({ ...i, line_kobo: i.price_kobo * i.qty }));
    return { items, subtotal_kobo: items.reduce((s, i) => s + i.line_kobo, 0), count: items.reduce((s, i) => s + i.qty, 0) };
  }
  function cartSet(sid, variantId, qty) {
    qty = Number(qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > 10) throw new AppError('Quantity must be between 0 and 10');
    const v = one(`SELECT v.id,${AVAIL} available FROM variants v WHERE v.id=?`, variantId);
    if (!v) throw new AppError('Unknown item', 404);
    if (qty === 0) run('DELETE FROM cart_items WHERE session_id=? AND variant_id=?', sid, variantId);
    else {
      if (qty > v.available) throw new AppError(v.available > 0 ? `Only ${v.available} left in stock` : 'Out of stock');
      run('INSERT INTO cart_items(session_id,variant_id,qty) VALUES(?,?,?) ON CONFLICT(session_id,variant_id) DO UPDATE SET qty=excluded.qty', sid, variantId, qty);
    }
    return cartGet(sid);
  }
  function cartAdd(sid, variantId, delta = 1) {
    const cur = one('SELECT qty FROM cart_items WHERE session_id=? AND variant_id=?', sid, variantId)?.qty || 0;
    return cartSet(sid, variantId, cur + Number(delta));
  }

  // ---------------- checkout / invoice / reservation ----------------
  function checkout(sid, input) {
    const m = DELIVERY[input.method];
    if (!m) throw new AppError('Choose pickup or a delivery option');
    const name = String(input.name || '').trim(), phone = String(input.phone || '').trim(), email = String(input.email || '').trim();
    const address = String(input.address || '').trim(), city = input.method === 'ibadan' ? 'Ibadan' : String(input.city || '').trim();
    if (name.length < 2) throw new AppError('Enter the recipient name');
    if (!/^\+?[0-9 ]{7,16}$/.test(phone)) throw new AppError('Enter a valid phone number');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('Enter a valid email (used for your receipt)');
    if (input.method !== 'pickup' && (address.length < 5 || city.length < 2)) throw new AppError('Enter the delivery address and city');
    return tx(() => {
      const rows = all(`SELECT c.variant_id,c.qty,p.name,p.price_kobo,v.size,v.colour,${AVAIL} available FROM cart_items c JOIN variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id WHERE c.session_id=?`, sid);
      if (!rows.length) throw new AppError('Your cart is empty');
      for (const r of rows) if (r.qty > r.available) throw new AppError(`Not enough stock for ${r.name} (${r.size}/${r.colour}): ${r.available} left`, 409);
      const subtotal = rows.reduce((s, r) => s + r.price_kobo * r.qty, 0); // prices come from DB only
      const fee = m.fee;
      const total = subtotal + (fee || 0);
      const invoice = {
        items: rows.map((r) => ({ name: r.name, size: r.size, colour: r.colour, qty: r.qty, unit_kobo: r.price_kobo, line_kobo: r.price_kobo * r.qty })),
        subtotal_kobo: subtotal,
        delivery: { method: input.method, label: m.label, fee_kobo: fee, quote_pending: fee === null },
        charges: [{ label: 'Service charges (none applied in this demo)', kobo: 0 }],
        total_kobo: total,
        recipient: { name, phone, email, address, city },
      };
      const token = crypto.randomBytes(24).toString('base64url');
      const id = Number(run(`INSERT INTO orders(public_token,session_id,recipient_name,phone,email,address,city,delivery_method,delivery_fee_kobo,quote_pending,subtotal_kobo,charges_kobo,total_kobo,invoice_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
        token, sid, name, phone, email, address, city, input.method, fee, fee === null ? 1 : 0, subtotal, total, JSON.stringify(invoice), plusMin(reserveMin), iso()).lastInsertRowid);
      run('UPDATE orders SET invoice_no=? WHERE id=?', 'INV-' + pad(id), id);
      for (const r of rows) {
        run('INSERT INTO order_items(order_id,variant_id,name,size,colour,unit_price_kobo,qty) VALUES(?,?,?,?,?,?,?)', id, r.variant_id, r.name, r.size, r.colour, r.price_kobo, r.qty);
        run('INSERT INTO reservations(order_id,variant_id,qty) VALUES(?,?,?)', id, r.variant_id, r.qty);
      }
      run('DELETE FROM cart_items WHERE session_id=?', sid);
      event(id, `Order ORD-${pad(id)} created. Stock reserved for ${reserveMin} minutes.`);
      return orderView(one('SELECT * FROM orders WHERE id=?', id));
    });
  }
  function orderByToken(token) {
    const o = typeof token === 'string' && token.length >= 20 ? one('SELECT * FROM orders WHERE public_token=?', token) : null;
    if (!o) throw new AppError('Order not found', 404);
    return o;
  }
  function sessionOrders(sid) {
    return all('SELECT * FROM orders WHERE session_id=? ORDER BY id DESC', sid).map((o) => orderView(o));
  }
  function orderView(o, admin = false) {
    const attempts = all('SELECT * FROM attempts WHERE order_id=? ORDER BY id', o.id).map((a) => {
      const cur = a.currency;
      const req = a.amount_units ? BigInt(a.amount_units) : null;
      const rec = sumReceipts(a.id);
      return {
        id: a.id, ref: a.internal_ref, method: a.method, provider: a.provider, status: a.status, currency: cur, expires_at: a.expires_at,
        instructions: a.instructions_json ? JSON.parse(a.instructions_json) : null,
        amount: req !== null ? fromUnits(req, cur) : null, received: req !== null ? fromUnits(rec, cur) : null,
        shortfall: req !== null && rec < req ? fromUnits(req - rec, cur) : '0',
        ...(admin ? { provider_id: a.provider_id, provider_raw: a.provider_raw ? JSON.parse(a.provider_raw) : null } : {}),
      };
    });
    const receipts = all('SELECT r.*,a.internal_ref FROM receipts r JOIN attempts a ON a.id=r.attempt_id WHERE r.order_id=? ORDER BY r.id', o.id)
      .map((r) => ({ amount: fromUnits(r.amount_units, r.currency), currency: r.currency, basis: r.basis, source: r.source, ref: r.internal_ref, at: r.created_at, ...(admin ? { evidence_id: r.evidence_id } : {}) }));
    return {
      id: o.id, display_id: 'ORD-' + pad(o.id), token: admin ? undefined : o.public_token, invoice_no: o.invoice_no, invoice: JSON.parse(o.invoice_json),
      payment_status: o.payment_status, fulfilment_status: o.fulfilment_status, settlement_status: o.settlement_status,
      quote_pending: !!o.quote_pending, total_kobo: o.total_kobo, expires_at: o.expires_at, created_at: o.created_at, paid_at: o.paid_at,
      receipt_no: o.receipt_no, courier: o.courier, tracking: o.tracking, attempts, receipts,
      events: all('SELECT text,created_at FROM order_events WHERE order_id=? ORDER BY id', o.id),
      ...(admin ? { reviews: all('SELECT * FROM reviews WHERE order_id=? ORDER BY id', o.id), recipient: { name: o.recipient_name, phone: o.phone, email: o.email, address: o.address, city: o.city } } : {}),
    };
  }
  const orderByTokenView = (token) => orderView(orderByToken(token));

  function cancelOrder(sid, token) {
    return tx(() => {
      const o = orderByToken(token);
      if (o.session_id !== sid) throw new AppError('Order not found', 404);
      if (o.payment_status !== 'UNPAID' || one('SELECT 1 FROM attempts WHERE order_id=?', o.id)) throw new AppError('This order can no longer be edited');
      for (const it of all('SELECT variant_id,qty FROM order_items WHERE order_id=?', o.id)) {
        const avail = one(`SELECT ${AVAIL} a FROM variants v WHERE v.id=?`, it.variant_id).a + it.qty; // include own hold
        run('INSERT INTO cart_items(session_id,variant_id,qty) VALUES(?,?,?) ON CONFLICT(session_id,variant_id) DO UPDATE SET qty=excluded.qty', sid, it.variant_id, Math.min(it.qty, Math.max(avail, 1)));
      }
      run("UPDATE reservations SET state='RELEASED' WHERE order_id=? AND state='HELD'", o.id);
      run("UPDATE orders SET payment_status='CANCELLED' WHERE id=?", o.id);
      event(o.id, 'Order cancelled by customer (edited); stock released.');
      return { ok: true };
    });
  }

  // ---------------- payments ----------------
  async function createPayment(token, method) {
    if (!['NGN', 'USDT'].includes(method)) throw new AppError('Unknown payment method');
    const cap = provider.capabilities()[method];
    if (!cap.enabled) throw new AppError(cap.reason || 'This payment route is unavailable', 503);
    let o = orderByToken(token);
    if (o.quote_pending) throw new AppError('Waiting for Amaka to confirm the delivery fee before you can pay', 409);
    if (!['UNPAID', 'PENDING', 'AWAITING_BALANCE'].includes(o.payment_status)) throw new AppError('This order is not payable (' + o.payment_status + ')', 409);
    if (o.expires_at < iso()) { await sweepExpired(); throw new AppError('This order expired and stock was released. Please start a new order.', 409); }
    for (const a of all("SELECT id FROM attempts WHERE order_id=? AND status='PENDING' AND expires_at<?", o.id, iso())) await reconcileAttempt(a.id);
    o = one('SELECT * FROM orders WHERE id=?', o.id);
    if (o.payment_status === 'PAID') return orderView(o);
    const live = one("SELECT * FROM attempts WHERE order_id=? AND method=? AND status IN('CREATING','PENDING')", o.id, method);
    if (live) return orderView(o);
    const unknown = one("SELECT created_at FROM attempts WHERE order_id=? AND method=? AND status='UNKNOWN' ORDER BY id DESC", o.id, method);
    if (unknown && Date.now() - Date.parse(unknown.created_at) < 120000) throw new AppError('A previous payment request may have been created but we could not confirm it. Please wait a couple of minutes and check status before retrying.', 409);
    const n = one('SELECT COUNT(*) c FROM attempts WHERE order_id=?', o.id).c + 1;
    const ref = `ORD-${pad(o.id)}-${method}-${n}`;
    let attemptId;
    try {
      attemptId = Number(run('INSERT INTO attempts(order_id,internal_ref,method,provider,status,created_at) VALUES(?,?,?,?,?,?)', o.id, ref, method, provider.mode, 'CREATING', iso()).lastInsertRowid);
    } catch { return orderView(one('SELECT * FROM orders WHERE id=?', o.id)); } // concurrent double-click: unique index
    try {
      const r = await provider.create(method, o, { internal_ref: ref });
      tx(() => {
        run("UPDATE attempts SET status='PENDING',provider_id=?,currency=?,amount_units=?,instructions_json=?,provider_raw=?,expires_at=? WHERE id=?", r.providerId, r.currency, r.amountUnits, JSON.stringify(r.instructions), JSON.stringify(r.raw), r.expiresAt, attemptId);
        run("UPDATE orders SET payment_status=CASE WHEN payment_status='UNPAID' THEN 'PENDING' ELSE payment_status END, expires_at=CASE WHEN expires_at<? THEN ? ELSE expires_at END WHERE id=?", r.expiresAt, r.expiresAt, o.id);
        event(o.id, `Payment instructions issued (${method === 'NGN' ? 'naira bank transfer' : 'USDT'}).`);
      });
    } catch (e) {
      run('UPDATE attempts SET status=? WHERE id=?', e.unknown ? 'UNKNOWN' : 'FAILED', attemptId);
      throw new AppError(e.message, 502);
    }
    return orderView(one('SELECT * FROM orders WHERE id=?', o.id));
  }

  // Applies verified evidence of money received. Single place that can mark an order PAID.
  function applyReceipt(attemptId, { units, evidenceId, basis, source }) {
    return tx(() => {
      const a = one('SELECT * FROM attempts WHERE id=?', attemptId);
      const o = one('SELECT * FROM orders WHERE id=?', a.order_id);
      if (one('SELECT 1 FROM receipts WHERE evidence_id=?', evidenceId)) return { duplicate: true };
      if (basis === 'status') {
        if (one("SELECT 1 FROM receipts WHERE attempt_id=? AND basis!='status'", a.id)) return { skipped: true };
      } else run("DELETE FROM receipts WHERE attempt_id=? AND basis='status'", a.id); // real evidence replaces status placeholder
      run('INSERT INTO receipts(attempt_id,order_id,currency,amount_units,evidence_id,basis,source,created_at) VALUES(?,?,?,?,?,?,?,?)', a.id, o.id, a.currency, String(units), evidenceId, basis, source, iso());
      const received = sumReceipts(a.id), required = BigInt(a.amount_units);
      const openReview = (kind, detail) => { if (!one("SELECT 1 FROM reviews WHERE order_id=? AND kind=? AND state='OPEN'", o.id, kind)) run('INSERT INTO reviews(order_id,kind,detail,created_at) VALUES(?,?,?,?)', o.id, kind, detail, iso()); };
      if (o.payment_status === 'PAID') {
        if (received !== required) { openReview('receipt_mismatch', `Receipts total ${fromUnits(received, a.currency)} vs required ${fromUnits(required, a.currency)} ${a.currency}`); event(o.id, 'Payment evidence updated; Amaka is reviewing a mismatch.'); }
        return { paid: true };
      }
      if (['EXPIRED', 'CANCELLED', 'REVIEW'].includes(o.payment_status)) {
        run("UPDATE orders SET payment_status='REVIEW' WHERE id=?", o.id);
        openReview('late_payment', `Payment of ${fromUnits(units, a.currency)} ${a.currency} arrived after reservation release. Check stock before fulfilling.`);
        event(o.id, 'A payment arrived after the reservation expired. Amaka will review it.');
        return { review: true };
      }
      if (received < required) {
        run("UPDATE orders SET payment_status='AWAITING_BALANCE' WHERE id=?", o.id);
        openReview('underpayment', `Received ${fromUnits(received, a.currency)} of ${fromUnits(required, a.currency)} ${a.currency}. Automatic top-up is not verified for Busha, so this needs manual handling.`);
        event(o.id, `Part payment received. Remaining: ${fromUnits(required - received, a.currency)} ${a.currency}. Your order will not be dispatched until the balance is paid.`);
        return { awaitingBalance: true };
      }
      run("UPDATE attempts SET status='PAID' WHERE id=?", a.id);
      run("UPDATE reviews SET state='RESOLVED',resolved_at=? WHERE order_id=? AND kind='underpayment' AND state='OPEN'", iso(), o.id);
      for (const r of all("SELECT * FROM reservations WHERE order_id=? AND state='HELD'", o.id)) {
        run('UPDATE variants SET stock=stock-? WHERE id=?', r.qty, r.variant_id);
        run("UPDATE reservations SET state='COMMITTED' WHERE id=?", r.id);
      }
      run("UPDATE orders SET payment_status='PAID',settlement_status='IN_PROVIDER_BALANCE',receipt_no=?,paid_at=? WHERE id=?", 'RCT-' + pad(o.id), iso(), o.id);
      if (received > required) { openReview('overpayment', `Excess of ${fromUnits(received - required, a.currency)} ${a.currency} received. Review before fulfilment.`); }
      event(o.id, `Payment verified. Receipt RCT-${pad(o.id)} issued.`);
      return { paid: true };
    });
  }

  async function reconcileAttempt(attemptId) {
    const a = one('SELECT * FROM attempts WHERE id=?', attemptId);
    if (!a || !a.provider_id || a.provider !== provider.mode) return { state: 'skip' };
    let st;
    try { st = await provider.getStatus(a); } catch (e) { return { state: 'error', error: e.message }; }
    if (st.state === 'paid') applyReceipt(a.id, { units: st.units, evidenceId: st.evidenceId, basis: st.basis, source: 'BUSHA' });
    else if (st.state === 'expired' || st.state === 'failed') run("UPDATE attempts SET status=? WHERE id=? AND status='PENDING'", st.state === 'expired' ? 'EXPIRED' : 'FAILED', a.id);
    return st;
  }
  async function refreshOrder(token) {
    const o = orderByToken(token);
    for (const a of all("SELECT id FROM attempts WHERE order_id=? AND status IN('PENDING')", o.id)) await reconcileAttempt(a.id);
    return orderView(one('SELECT * FROM orders WHERE id=?', o.id));
  }

  async function handleWebhook(raw, headers) {
    if (!provider.verifyWebhook(raw, headers['x-bu-signature'])) { audit('webhook', 'rejected', 'invalid signature'); return { status: 401, body: { error: 'invalid signature' } }; }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { error: 'bad json' } }; }
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const ins = db.prepare('INSERT OR IGNORE INTO webhook_events(hash,event,raw,created_at) VALUES(?,?,?,?)').run(hash, body.event, raw.toString('utf8'), iso());
    if (!ins.changes) return { status: 200, body: { ok: true, duplicate: true } };
    const d = body.data || {};
    let note = 'ignored';
    if (/^(transfer|payment_request)\./.test(body.event || '')) {
      const a = one("SELECT * FROM attempts WHERE provider='busha' AND provider_id=?", d.id);
      if (a) { await reconcileAttempt(a.id); note = 'reconciled ' + a.internal_ref; } else note = 'no matching attempt';
    } else if (body.event === 'deposit.success') {
      const a = d.account_number ? one("SELECT * FROM attempts WHERE provider='busha' AND method='NGN' AND json_extract(instructions_json,'$.account_number')=?", String(d.account_number)) : null;
      if (a && d.currency === 'NGN' && d.status === 'COMPLETED') { applyReceipt(a.id, { units: toUnits(d.total, 'NGN'), evidenceId: 'deposit:' + d.id, basis: 'deposit_event', source: 'BUSHA' }); note = 'deposit applied ' + a.internal_ref; }
      else { run('INSERT INTO reviews(order_id,kind,detail,created_at) VALUES(NULL,?,?,?)', 'unmatched_payment', `Deposit ${d.total} ${d.currency} to account ${d.account_number} matched no open attempt`, iso()); note = 'unmatched'; }
    }
    run('UPDATE webhook_events SET processed=1,note=? WHERE hash=?', note, hash);
    return { status: 200, body: { ok: true } };
  }

  async function sweepExpired() {
    const due = all("SELECT * FROM orders WHERE payment_status IN('UNPAID','PENDING','AWAITING_BALANCE') AND expires_at<?", iso());
    for (const o of due) {
      for (const a of all("SELECT id FROM attempts WHERE order_id=? AND status='PENDING'", o.id)) await reconcileAttempt(a.id);
      tx(() => {
        const cur = one('SELECT * FROM orders WHERE id=?', o.id);
        if (!['UNPAID', 'PENDING', 'AWAITING_BALANCE'].includes(cur.payment_status)) return;
        run("UPDATE attempts SET status='EXPIRED' WHERE order_id=? AND status IN('PENDING','CREATING')", o.id);
        run("UPDATE reservations SET state='RELEASED' WHERE order_id=? AND state='HELD'", o.id);
        const partial = one('SELECT 1 FROM receipts WHERE order_id=?', o.id);
        run('UPDATE orders SET payment_status=? WHERE id=?', partial ? 'REVIEW' : 'EXPIRED', o.id);
        if (partial) run('INSERT INTO reviews(order_id,kind,detail,created_at) VALUES(?,?,?,?)', o.id, 'expired_with_partial', 'Order expired with a part payment received. Decide refund/top-up manually.', iso());
        event(o.id, partial ? 'Order expired with a part payment; Amaka will review.' : 'Order expired unpaid; reserved stock released.');
      });
    }
  }

  // ---------------- merchant ----------------
  function adminOrders({ payment, fulfilment } = {}) {
    let sql = 'SELECT * FROM orders WHERE 1=1'; const p = [];
    if (payment) { sql += ' AND payment_status=?'; p.push(payment); }
    if (fulfilment) { sql += ' AND fulfilment_status=?'; p.push(fulfilment); }
    return all(sql + ' ORDER BY id DESC LIMIT 200', ...p).map((o) => ({ id: o.id, display_id: 'ORD-' + pad(o.id), total_kobo: o.total_kobo, payment_status: o.payment_status, fulfilment_status: o.fulfilment_status, settlement_status: o.settlement_status, quote_pending: !!o.quote_pending, recipient: o.recipient_name, created_at: o.created_at }));
  }
  function adminOrder(id) {
    const o = one('SELECT * FROM orders WHERE id=?', id);
    if (!o) throw new AppError('Not found', 404);
    return orderView(o, true);
  }
  function fulfilGuard(o) {
    if (o.payment_status !== 'PAID') throw new AppError('Only verified-paid orders can be fulfilled', 409);
    if (one(`SELECT 1 FROM reviews WHERE order_id=? AND state='OPEN' AND kind IN(${BLOCKING.map(() => '?').join(',')})`, o.id, ...BLOCKING)) throw new AppError('Resolve the open payment review first', 409);
  }
  function pack(id, actor) {
    return tx(() => {
      const o = one('SELECT * FROM orders WHERE id=?', id); if (!o) throw new AppError('Not found', 404);
      fulfilGuard(o);
      if (o.fulfilment_status !== 'NONE') throw new AppError('Already ' + o.fulfilment_status, 409);
      run("UPDATE orders SET fulfilment_status='PACKED' WHERE id=?", id);
      event(id, 'Your order has been packed.'); audit(actor, 'pack', { id });
      return adminOrder(id);
    });
  }
  function dispatch(id, courier, tracking, actor) {
    return tx(() => {
      const o = one('SELECT * FROM orders WHERE id=?', id); if (!o) throw new AppError('Not found', 404);
      fulfilGuard(o);
      if (o.fulfilment_status !== 'PACKED') throw new AppError('Pack the order first', 409);
      courier = String(courier || '').trim(); tracking = String(tracking || '').trim();
      if (!courier || !tracking) throw new AppError('Courier and tracking details are required');
      run("UPDATE orders SET fulfilment_status='DISPATCHED',courier=?,tracking=? WHERE id=?", courier, tracking, id);
      event(id, `Dispatched via ${courier}. Tracking: ${tracking}.`); audit(actor, 'dispatch', { id, courier });
      return adminOrder(id);
    });
  }
  function setDeliveryFee(id, kobo, actor) {
    return tx(() => {
      const o = one('SELECT * FROM orders WHERE id=?', id); if (!o) throw new AppError('Not found', 404);
      if (!o.quote_pending || o.payment_status !== 'UNPAID') throw new AppError('No pending delivery quote on this order', 409);
      kobo = Number(kobo); if (!Number.isInteger(kobo) || kobo < 0) throw new AppError('Invalid fee');
      const inv = JSON.parse(o.invoice_json); inv.delivery.fee_kobo = kobo; inv.delivery.quote_pending = false; inv.total_kobo = o.subtotal_kobo + kobo;
      run('UPDATE orders SET delivery_fee_kobo=?,quote_pending=0,total_kobo=?,invoice_json=?,expires_at=? WHERE id=?', kobo, inv.total_kobo, JSON.stringify(inv), plusMin(reserveMin), id);
      event(id, 'Amaka confirmed your delivery fee. You can now pay.'); audit(actor, 'delivery_fee', { id, kobo });
      return adminOrder(id);
    });
  }
  const reviewsList = () => all('SELECT * FROM reviews ORDER BY state DESC,id DESC LIMIT 200');
  function resolveReview(id, actor) { run("UPDATE reviews SET state='RESOLVED',resolved_at=? WHERE id=?", iso(), id); audit(actor, 'resolve_review', { id }); return { ok: true }; }
  const adminVariants = () => all(`SELECT v.id,p.name,v.size,v.colour,v.stock,${AVAIL} available FROM variants v JOIN products p ON p.id=v.product_id ORDER BY p.id,v.id`);
  function setStock(variantId, stock, actor) {
    stock = Number(stock);
    if (!Number.isInteger(stock) || stock < 0) throw new AppError('Invalid stock');
    return tx(() => {
      const held = one("SELECT COALESCE(SUM(qty),0) h FROM reservations WHERE variant_id=? AND state='HELD'", variantId).h;
      if (stock < held) throw new AppError(`${held} units are reserved by open orders`, 409);
      if (!run('UPDATE variants SET stock=? WHERE id=?', stock, variantId).changes) throw new AppError('Not found', 404);
      audit(actor, 'set_stock', { variantId, stock });
      return { ok: true };
    });
  }
  async function simulate(attemptId, scenario, actor) {
    if (provider.mode !== 'mock') throw new AppError('Not found', 404);
    const a = one('SELECT * FROM attempts WHERE id=?', attemptId);
    if (!a || a.provider !== 'mock') throw new AppError('Mock attempt not found', 404);
    const req = BigInt(a.amount_units), pay = (u, id) => applyReceipt(a.id, { units: u, evidenceId: id, basis: 'mock_event', source: 'MOCK' });
    audit(actor, 'mock_simulate', { attemptId, scenario });
    const uid = () => 'mock:' + crypto.randomUUID();
    if (scenario === 'full') return pay(req, uid());
    if (scenario === 'partial') return pay((req * 80n) / 100n, uid());
    if (scenario === 'excess') return pay((req * 110n) / 100n, uid());
    if (scenario === 'duplicate') { const id = 'mock:dup:' + a.id; pay(req, id); return pay(req, id); }
    if (scenario === 'expired') { run('UPDATE orders SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), a.order_id); await sweepExpired(); return { expired: true }; }
    throw new AppError('Unknown scenario');
  }
  function merchantLogin(email, password) {
    const m = one('SELECT * FROM merchants WHERE email=?', String(email || '').toLowerCase());
    if (!m) return false;
    const [salt, hash] = m.pw_hash.split(':');
    const test = crypto.scryptSync(String(password || ''), salt, 32);
    return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex')) ? m : false;
  }
  function seedMerchant(email, password) {
    if (!password || one('SELECT 1 FROM merchants LIMIT 1')) return;
    const salt = crypto.randomBytes(16).toString('hex');
    run('INSERT INTO merchants(email,pw_hash) VALUES(?,?)', email.toLowerCase(), salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex'));
  }

  return { db, provider, ensureSession, listProducts, cartGet, cartSet, cartAdd, checkout, orderByToken, orderView, orderByTokenView, sessionOrders, cancelOrder,
    createPayment, applyReceipt, reconcileAttempt, refreshOrder, handleWebhook, sweepExpired, adminOrders, adminOrder, pack, dispatch, setDeliveryFee,
    reviewsList, resolveReview, adminVariants, setStock, simulate, merchantLogin, seedMerchant, audit };
}
