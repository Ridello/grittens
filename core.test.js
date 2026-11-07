import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createServices, AppError } from '../src/services.js';
import { MockProvider, BushaProvider } from '../src/providers.js';
import { makeChat } from '../src/chat.js';

function setup(provider = new MockProvider()) {
  const db = openDb(':memory:');
  const svc = createServices(db, provider);
  return { db, svc };
}
const info = { method: 'ibadan', name: 'Ada Obi', phone: '+2348012345678', email: 'ada@example.com', address: '12 Bodija Road', city: 'Ibadan' };
async function paidFlow(svc, sid, method = 'NGN') {
  const v = svc.listProducts()[0].variants[0];
  svc.cartSet(sid, v.id, 1);
  const o = svc.checkout(sid, info);
  const withPay = await svc.createPayment(o.token, method);
  return { o, withPay, attempt: withPay.attempts[0] };
}

test('server computes price; delivery is in invoice before payment', () => {
  const { svc } = setup(); const sid = svc.ensureSession();
  const p = svc.listProducts()[0]; svc.cartSet(sid, p.variants[0].id, 2);
  const o = svc.checkout(sid, info);
  assert.equal(o.invoice.subtotal_kobo, p.price_kobo * 2);
  assert.equal(o.invoice.delivery.fee_kobo, 150000);
  assert.equal(o.total_kobo, p.price_kobo * 2 + 150000);
  assert.equal(o.payment_status, 'UNPAID');
});

test('cart is shared between storefront and chat (same session, same service)', async () => {
  const { svc } = setup(); const sid = svc.ensureSession(); const chat = makeChat(svc);
  const v = svc.listProducts()[0].variants[0];
  await chat(sid, 'add', { variantId: v.id, qty: 2 });
  assert.equal(svc.cartGet(sid).count, 2);
  svc.cartSet(sid, v.id, 1);
  const r = await chat(sid, 'cart');
  assert.match(r.messages[0].text, /1 ×/);
});

test('last unit cannot be oversold', () => {
  const { svc, db } = setup();
  const v = db.prepare("SELECT id FROM variants WHERE stock=1").get();
  const a = svc.ensureSession(), b = svc.ensureSession();
  svc.cartSet(a, v.id, 1); svc.cartSet(b, v.id, 1);
  svc.checkout(a, info);
  assert.throws(() => svc.checkout(b, info), /Not enough stock/);
});

test('full payment confirms once, commits stock once, issues receipt', async () => {
  const { svc, db } = setup(); const sid = svc.ensureSession();
  const v = svc.listProducts()[0].variants[0];
  const { o, attempt } = await paidFlow(svc, sid);
  assert.equal(attempt.status, 'PENDING');
  const before = db.prepare('SELECT stock FROM variants WHERE id=?').get(v.id).stock;
  await svc.simulate(attempt.id, 'duplicate', 't');
  await svc.simulate(attempt.id, 'full', 't'); // second, different evidence after PAID => mismatch review, no double stock
  const view = svc.orderByTokenView(o.token);
  assert.equal(view.payment_status, 'PAID');
  assert.ok(view.receipt_no);
  assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(v.id).stock, before - 1);
});

test('duplicate event has no repeated effect', async () => {
  const { svc } = setup(); const sid = svc.ensureSession();
  const { o, attempt } = await paidFlow(svc, sid);
  await svc.simulate(attempt.id, 'duplicate', 't');
  const v = svc.orderByTokenView(o.token);
  assert.equal(v.receipts.length, 1);
});

test('underpayment stays unpaid, shows shortfall, cannot be packed', async () => {
  const { svc } = setup(); const sid = svc.ensureSession();
  const { o, attempt } = await paidFlow(svc, sid);
  await svc.simulate(attempt.id, 'partial', 't');
  const v = svc.orderByTokenView(o.token);
  assert.equal(v.payment_status, 'AWAITING_BALANCE');
  assert.notEqual(v.attempts[0].shortfall, '0');
  assert.equal(v.receipt_no, null);
  assert.throws(() => svc.pack(v.id, 't'), /verified-paid/);
});

test('exact NGN 25,000 vs 20,000 arithmetic', async () => {
  const { svc, db } = setup(); const sid = svc.ensureSession();
  const { o, attempt } = await paidFlow(svc, sid);
  db.prepare('UPDATE attempts SET amount_units=? WHERE id=?').run('2500000', attempt.id);
  svc.applyReceipt(attempt.id, { units: 2000000n, evidenceId: 'x1', basis: 'mock_event', source: 'MOCK' });
  const v = svc.orderByTokenView(o.token);
  assert.equal(v.payment_status, 'AWAITING_BALANCE');
  assert.equal(v.attempts[0].shortfall, '5000.00');
});

test('overpayment records excess and blocks fulfilment until reviewed', async () => {
  const { svc } = setup(); const sid = svc.ensureSession();
  const { o, attempt } = await paidFlow(svc, sid);
  await svc.simulate(attempt.id, 'excess', 't');
  const id = svc.orderByTokenView(o.token).id;
  assert.throws(() => svc.pack(id, 't'), /review/);
  const rv = svc.reviewsList().find((r) => r.kind === 'overpayment'); assert.ok(rv);
  svc.resolveReview(rv.id, 't');
  assert.equal(svc.pack(id, 't').fulfilment_status, 'PACKED');
  assert.equal(svc.dispatch(id, 'GIG', 'TRK1', 't').fulfilment_status, 'DISPATCHED');
});

test('expired order releases stock; late payment goes to review, stock not committed', async () => {
  const { svc, db } = setup(); const sid = svc.ensureSession();
  const v = svc.listProducts()[0].variants[0];
  const { o, attempt } = await paidFlow(svc, sid);
  await svc.simulate(attempt.id, 'expired', 't');
  assert.equal(svc.orderByTokenView(o.token).payment_status, 'EXPIRED');
  const stock = db.prepare('SELECT stock FROM variants WHERE id=?').get(v.id).stock;
  svc.applyReceipt(attempt.id, { units: BigInt(attempt.amount.replace('.', '')), evidenceId: 'late1', basis: 'mock_event', source: 'MOCK' });
  assert.equal(svc.orderByTokenView(o.token).payment_status, 'REVIEW');
  assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(v.id).stock, stock);
});

test('customer cannot access another order; unguessable token', () => {
  const { svc } = setup(); const a = svc.ensureSession(), b = svc.ensureSession();
  svc.cartSet(a, svc.listProducts()[0].variants[0].id, 1);
  const o = svc.checkout(a, info);
  assert.equal(svc.sessionOrders(b).length, 0);
  assert.throws(() => svc.orderByTokenView('ORD-00001'), AppError);
  assert.throws(() => svc.cancelOrder(b, o.token), /not found/);
});

test('double-click create-payment yields one attempt', async () => {
  const { svc } = setup(); const sid = svc.ensureSession();
  svc.cartSet(sid, svc.listProducts()[0].variants[0].id, 1);
  const o = svc.checkout(sid, info);
  await Promise.all([svc.createPayment(o.token, 'NGN'), svc.createPayment(o.token, 'NGN')]);
  assert.equal(svc.orderByTokenView(o.token).attempts.length, 1);
});

test('manual-quote delivery blocks payment until Amaka sets fee', async () => {
  const { svc } = setup(); const sid = svc.ensureSession();
  svc.cartSet(sid, svc.listProducts()[0].variants[0].id, 1);
  const o = svc.checkout(sid, { ...info, method: 'other', city: 'Abuja' });
  await assert.rejects(svc.createPayment(o.token, 'NGN'), /delivery fee/);
  svc.setDeliveryFee(o.id, 250000, 't');
  const w = await svc.createPayment(o.token, 'NGN');
  assert.equal(w.total_kobo, o.invoice.subtotal_kobo + 250000);
});

// ---------- Busha adapter ----------
const sign = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('base64');

test('Busha webhook: invalid signature changes nothing; valid one is accepted; replay is deduped', async () => {
  const p = new BushaProvider({ BUSHA_SECRET_KEY: 'k', BUSHA_WEBHOOK_SECRET: 'whsec' });
  const { svc, db } = setup(p);
  const raw = Buffer.from(JSON.stringify({ event: 'transfer.pending', data: { id: 'TRF_x' } }));
  assert.equal((await svc.handleWebhook(raw, { 'x-bu-signature': 'AAAA' })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM webhook_events').get().c, 0);
  assert.equal((await svc.handleWebhook(raw, { 'x-bu-signature': sign('whsec', raw) })).status, 200);
  const r2 = await svc.handleWebhook(raw, { 'x-bu-signature': sign('whsec', raw) });
  assert.equal(r2.body.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM webhook_events').get().c, 1);
});

test('Busha NGN route uses documented endpoints (stubbed responses) and deposit.success underpayment', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    const j = (d) => ({ ok: true, status: 200, json: async () => d });
    if (url.endsWith('/v1/quotes')) return j({ status: 'success', data: { id: 'QUO_1' } });
    if (url.endsWith('/v1/transfers')) return j({ data: { id: 'TRF_1', source_amount: calls[0].body.source_amount, pay_in: { expires_at: new Date(Date.now() + 3600e3).toISOString(), recipient_details: { account_name: 'Payaza', account_number: '7000384620', bank_name: 'TEST BANK' }, type: 'temporary_bank_account' }, status: 'pending' } });
    return j({ data: { id: 'TRF_1', status: 'pending', source_amount: '1' } });
  };
  try {
    const p = new BushaProvider({ BUSHA_SECRET_KEY: 'secret-k', BUSHA_WEBHOOK_SECRET: 'whsec' });
    const { svc } = setup(p); const sid = svc.ensureSession();
    svc.cartSet(sid, svc.listProducts()[0].variants[0].id, 1);
    const o = svc.checkout(sid, info);
    const w = await svc.createPayment(o.token, 'NGN');
    assert.equal(calls[0].url, 'https://api.sandbox.busha.so/v1/quotes');
    assert.equal(calls[0].auth, 'Bearer secret-k');
    assert.deepEqual(calls[0].body.pay_in, { type: 'temporary_bank_account' });
    assert.equal(calls[1].body.quote_id, 'QUO_1');
    assert.equal(w.attempts[0].instructions.account_number, '7000384620');
    // deposit.success with less money than required => AWAITING_BALANCE, not paid
    const ev = Buffer.from(JSON.stringify({ event: 'deposit.success', data: { id: 'dep-1', amount: '100.00', fee: '0', total: '100.00', currency: 'NGN', status: 'COMPLETED', account_number: '7000384620' } }));
    await svc.handleWebhook(ev, { 'x-bu-signature': sign('whsec', ev) });
    const v = svc.orderByTokenView(o.token);
    assert.equal(v.payment_status, 'AWAITING_BALANCE');
    assert.equal(v.receipt_no, null);
  } finally { globalThis.fetch = realFetch; }
});

test('missing credentials never fake success', async () => {
  const p = new BushaProvider({});
  const { svc, db } = setup(p); const sid = svc.ensureSession();
  svc.cartSet(sid, svc.listProducts()[0].variants[0].id, 1);
  const o = svc.checkout(sid, info);
  await assert.rejects(svc.createPayment(o.token, 'NGN'), /Setup required/);
  await assert.rejects(svc.createPayment(o.token, 'USDT'), /unavailable/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM attempts').get().c, 0);
});

test('simulation is unavailable outside mock mode; production URL rejected', async () => {
  const { svc } = setup(new BushaProvider({ BUSHA_SECRET_KEY: 'k' }));
  await assert.rejects(svc.simulate(1, 'full', 't'), /Not found/);
  assert.throws(() => new BushaProvider({ BUSHA_BASE_URL: 'https://api.busha.io' }), /sandbox/);
});
