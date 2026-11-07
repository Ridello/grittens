import crypto from 'node:crypto';
import { toUnits, fromUnits } from './money.js';

// ---------------------------------------------------------------------------
// Busha sandbox contract (source: docs.busha.io, fetched 2026-11-07)
//  NGN  : POST /v1/quotes {source_currency:NGN,target_currency:NGN,source_amount,pay_in:{type:temporary_bank_account}}
//         POST /v1/transfers {quote_id}  -> data.id (TRF_), data.pay_in.recipient_details, data.pay_in.expires_at
//         GET  /v1/transfers/{id}        -> data.status (pending|processing|funds_received|completed|failed|cancelled)
//         Auth: Authorization: Bearer <secret key>.  Quotes are valid 3 minutes -> transfer is created immediately.
//  USDT : POST /v1/payments/requests (header X-BU-PUBLIC-KEY) {quote_amount,quote_currency:NGN,source_currency:USDT,
//         target_currency:USDT,pay_in:{type:address,network},additional_info:{email,phone_number},reference}
//         -> data.id (PAYR_), data.source_amount (USDT), data.pay_in.address/network/expires_at
//         GET  /v1/payments/requests/{id} (public key) -> data.status, data.timeline.transfer_status
//  Webhook: header x-bu-signature = base64(HMAC-SHA256(raw body, webhook secret)). Events used:
//         transfer.*, payment_request.*, deposit.success (data.total/amount/currency/account_number/id)
// UNVERIFIED (flagged in README): sandbox partial-payment behaviour, full list of payment_request statuses,
//         whether quotes accept a caller reference, whether the sandbox can simulate a deposit programmatically.
// ---------------------------------------------------------------------------

const PAID_TRANSFER = ['funds_received', 'completed', 'funds_converted'];

export class MockProvider {
  mode = 'mock';
  label = 'SIMULATED PAYMENTS';
  capabilities() {
    return { NGN: { enabled: true, simulated: true }, USDT: { enabled: true, simulated: true } };
  }
  async create(method, order, attempt) {
    const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
    if (method === 'NGN') {
      return {
        providerId: 'MOCK_' + attempt.internal_ref, currency: 'NGN', amountUnits: String(order.total_kobo), expiresAt,
        instructions: { type: 'bank_transfer', simulated: true, bank_name: 'SIMULATED BANK', account_name: 'SIMULATED – AMAKA CLOSET', account_number: '0000' + String(order.id).padStart(6, '0'), amount: fromUnits(order.total_kobo, 'NGN'), currency: 'NGN' },
        raw: { simulated: true },
      };
    }
    const rate = 1500n; // demo NGN/USDT rate, SIMULATED only
    const units = (BigInt(order.total_kobo) * 10000n) / rate; // kobo -> 6dp USDT units
    return {
      providerId: 'MOCK_' + attempt.internal_ref, currency: 'USDT', amountUnits: units.toString(), expiresAt,
      instructions: { type: 'address', simulated: true, network: 'SIMULATED-TRX', address: 'SIMULATED-' + attempt.internal_ref, amount: fromUnits(units, 'USDT'), currency: 'USDT', note: 'Demo rate 1 USDT = ₦1,500 (simulated)' },
      raw: { simulated: true },
    };
  }
  async getStatus() { return { state: 'pending' }; }
  verifyWebhook() { return false; }
}

export class BushaProvider {
  mode = 'busha';
  label = 'BUSHA SANDBOX — TEST ENVIRONMENT';
  constructor(env = process.env) {
    this.base = (env.BUSHA_BASE_URL || 'https://api.sandbox.busha.so').replace(/\/$/, '');
    if (!/sandbox/.test(this.base)) throw new Error('BUSHA_BASE_URL must be the sandbox URL. Production is out of scope.');
    this.secret = env.BUSHA_SECRET_KEY || '';
    this.pub = env.BUSHA_PUBLIC_KEY || '';
    this.whSecret = env.BUSHA_WEBHOOK_SECRET || '';
    this.network = env.BUSHA_USDT_NETWORK || 'TRX';
  }
  capabilities() {
    return {
      NGN: this.secret ? { enabled: true } : { enabled: false, reason: 'Setup required: BUSHA_SECRET_KEY is not configured.' },
      USDT: this.pub ? { enabled: true } : { enabled: false, reason: 'USDT unavailable: Busha payment requests need BUSHA_PUBLIC_KEY (not configured).' },
    };
  }
  async call(method, path, { auth, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth === 'secret') headers.Authorization = 'Bearer ' + this.secret;
    else headers['X-BU-PUBLIC-KEY'] = this.pub;
    let res;
    try {
      res = await fetch(this.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      const err = new Error('Could not reach Busha (' + (e.name === 'TimeoutError' ? 'timeout' : 'network error') + ')');
      err.unknown = method !== 'GET';
      throw err;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Busha ${res.status}: ${json?.error?.message || json?.message || 'request failed'}`);
      err.unknown = method !== 'GET' && res.status >= 500;
      throw err;
    }
    return json;
  }
  async create(method, order, attempt) {
    if (method === 'NGN') {
      const amount = fromUnits(order.total_kobo, 'NGN', true);
      const q = await this.call('POST', '/v1/quotes', { auth: 'secret', body: { source_currency: 'NGN', target_currency: 'NGN', source_amount: amount, pay_in: { type: 'temporary_bank_account' } } });
      const t = await this.call('POST', '/v1/transfers', { auth: 'secret', body: { quote_id: q.data.id } });
      const d = t.data, rd = d?.pay_in?.recipient_details;
      if (!rd?.account_number) throw new Error('Busha response did not include bank details');
      return {
        providerId: d.id, currency: 'NGN', amountUnits: toUnits(d.source_amount, 'NGN').toString(), expiresAt: d.pay_in.expires_at,
        instructions: { type: 'bank_transfer', bank_name: rd.bank_name, account_name: rd.account_name, account_number: rd.account_number, amount: d.source_amount, currency: 'NGN', provider_fees: d.fees || [], quote_id: q.data.id },
        raw: d,
      };
    }
    const r = await this.call('POST', '/v1/payments/requests', {
      auth: 'public',
      body: { quote_amount: fromUnits(order.total_kobo, 'NGN', true), quote_currency: 'NGN', source_currency: 'USDT', target_currency: 'USDT', pay_in: { type: 'address', network: this.network }, additional_info: { email: order.email, phone_number: order.phone }, reference: attempt.internal_ref },
    });
    const d = r.data;
    if (!d?.pay_in?.address) throw new Error('Busha response did not include a payment address');
    return {
      providerId: d.id, currency: 'USDT', amountUnits: toUnits(d.source_amount, 'USDT').toString(), expiresAt: d.pay_in.expires_at || d.expires_at,
      instructions: { type: 'address', network: d.pay_in.network, address: d.pay_in.address, amount: d.source_amount, currency: 'USDT' },
      raw: d,
    };
  }
  async getStatus(attempt) {
    if (attempt.method === 'NGN') {
      const d = (await this.call('GET', '/v1/transfers/' + attempt.provider_id, { auth: 'secret' })).data;
      if (PAID_TRANSFER.includes(d.status)) return { state: 'paid', units: toUnits(d.source_amount, 'NGN'), evidenceId: 'status:' + attempt.provider_id, basis: 'status' };
      if (['cancelled'].includes(d.status)) return { state: 'expired' };
      if (d.status === 'failed') return { state: 'failed' };
      return { state: 'pending', providerStatus: d.status };
    }
    const d = (await this.call('GET', '/v1/payments/requests/' + attempt.provider_id, { auth: 'public' })).data;
    const ts = d.timeline?.transfer_status;
    if (d.status === 'completed' || PAID_TRANSFER.includes(ts)) return { state: 'paid', units: toUnits(d.source_amount, 'USDT'), evidenceId: 'status:' + attempt.provider_id, basis: 'status' };
    if (d.status === 'expired') return { state: 'expired' };
    if (['failed', 'cancelled'].includes(d.status)) return { state: 'failed' };
    return { state: 'pending', providerStatus: d.status };
  }
  verifyWebhook(raw, signature) {
    if (!this.whSecret || !signature) return false;
    const expected = crypto.createHmac('sha256', this.whSecret).update(raw).digest();
    let actual;
    try { actual = Buffer.from(String(signature), 'base64'); } catch { return false; }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
}

export function getProvider(env = process.env) {
  return (env.PAYMENT_MODE || 'mock') === 'busha' ? new BushaProvider(env) : new MockProvider();
}
