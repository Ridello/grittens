# Amaka’s Closet × Busha — Order-to-Door (Team Gritten)

Mobile-first clothing store + embedded chat assistant + merchant dashboard. Naira and USDT payments through the **Busha sandbox**, with verified-evidence-only payment status.

## Run it
```bash
node -v                      # needs Node >= 22.13 (uses built-in node:sqlite, zero npm dependencies)
cp .env.example .env         # fill in values, never commit .env
npm test                     # 16 tests
npm start                    # http://localhost:3000   (customer)   /admin  (merchant)
```
Modes (`PAYMENT_MODE`):
- `mock` (default): persistent **SIMULATED PAYMENTS** banner, protected simulation controls at `/admin` → *Simulated payments* (full / partial / excess / duplicate / expired). Webhook route returns 404.
- `busha`: persistent **BUSHA SANDBOX — TEST ENVIRONMENT** banner. Real sandbox requests, no mock fallback, simulation routes return 404. Missing credentials ⇒ the route shows “Setup required” and nothing is created.

## Go live on Busha sandbox (checklist)
1. `.env`: `PAYMENT_MODE=busha`, `BUSHA_SECRET_KEY=<sandbox secret key>`, `ADMIN_PASSWORD`, `SESSION_SECRET`.
2. Deploy publicly over HTTPS (any Node 22 host with a **persistent disk** for `DB_PATH`, e.g. Render/Railway/Fly). Start command `npm start`.
3. Busha dashboard → Settings → Developer Tools → Webhooks → create webhook to `https://<your-host>/api/webhooks/busha`, subscribe to `transfer.*`, `deposit.success`, `payment_request.*`; copy the secret to `BUSHA_WEBHOOK_SECRET`.
4. USDT route is enabled only if `BUSHA_PUBLIC_KEY` (Settings → Developer Tools → API Tokens) is set; otherwise it is shown as unavailable.
5. Place a naira order, pay the displayed temporary account from the sandbox, watch the order page / `/admin`.

## Architecture
```
Instagram link ─► Website (public/index.html: store, cart, checkout, order page, chat panel)
                        │ same cookie session (sid)           /admin (merchant, signed cookie)
                        ▼                                         │
                 src/server.js (routes, rate limits, CSRF-by-JSON, raw webhook body)
                        ▼
   src/services.js  catalogue · cart · reservation · invoice snapshot · orders · payments · reconcile · merchant
   src/chat.js      thin chat UI that calls the SAME services
                        ▼
   src/providers.js MockProvider | BushaProvider ──► api.sandbox.busha.so (quotes, transfers, payments/requests)
                        ▲
   POST /api/webhooks/busha (HMAC x-bu-signature) ─► dedupe ─► match attempt ─► GET status / deposit evidence ─► applyReceipt (one transaction)
                        ▼
                   SQLite (node:sqlite)
```

## Busha contract used (docs.busha.io, read 2026-11-07)
| Route | Calls | Fields used |
|---|---|---|
| NGN | `POST /v1/quotes` (`source/target_currency=NGN`, `source_amount`, `pay_in.type=temporary_bank_account`) then `POST /v1/transfers {quote_id}`; status via `GET /v1/transfers/{id}`; `Authorization: Bearer <secret>` | `data.id`, `data.pay_in.recipient_details`, `data.pay_in.expires_at`, `data.source_amount`, `data.status` |
| USDT | `POST /v1/payments/requests` and `GET /v1/payments/requests/{id}` with `X-BU-PUBLIC-KEY` | `data.id`, `pay_in.address/network/expires_at`, `source_amount`, `status`, `timeline.transfer_status` |
| Webhook | `x-bu-signature` = base64(HMAC-SHA256(raw body, webhook secret)) | events `transfer.*`, `payment_request.*`, `deposit.success` |

Quotes are valid 3 minutes, so the transfer is created immediately after the quote.

## Payment safety rules implemented
- Status changes only inside `applyReceipt`, fed by (a) a verified webhook (`deposit.success` carries the real `total`) or (b) a provider status GET. “I have paid” only calls refresh.
- Amounts are BigInt units (NGN kobo, USDT 6dp). Required vs received compared in one currency.
- Underpayment ⇒ `AWAITING_BALANCE`, shortfall shown, packing/dispatch refused. Overpayment ⇒ paid + `overpayment` review that blocks fulfilment until resolved. Late payment after reservation release ⇒ `REVIEW`, stock not committed. Duplicate events deduped by raw-body hash and evidence id. Unmatched deposit ⇒ review queue.
- Payment status, fulfilment status and settlement status are separate. Settlement is only ever “held in provider balance”, never claimed as bank settlement.
- One open attempt per order+method is enforced by a unique index (double-click safe). If Busha create times out the attempt is `UNKNOWN`, and a retry is blocked for 2 minutes.

## Known limitations / unverified (be honest in the demo)
- **Not yet run against the live Busha sandbox**: it was written from the docs; the build environment had no route to `api.sandbox.busha.so`. Tests use stubbed responses shaped like the documented samples. Run step 5 above and save redacted responses as fixtures.
- Busha does not document partial-deposit behaviour or a top-up flow. For a transfer reported `funds_received/completed` with no `deposit.success` evidence, receipt amount falls back to the transfer’s `source_amount` (basis `status`); a later real `deposit.success` replaces it. Real underpayment in sandbox is therefore only proven via `deposit.success` events or the **mock** scenario (labelled SIMULATED). Automatic top-up is not implemented: underpayment goes to manual review.
- The full set of `payment_request` statuses and whether quotes accept a caller reference are undocumented; we only rely on `completed`, `expired`, `failed`, `cancelled`, `pending`.
- USDT needs `BUSHA_PUBLIC_KEY`; the NGN→USDT amount is calculated by Busha (we never invent a rate; mock uses a labelled demo rate).
- Order/receipt “notifications” are recorded as order updates (`order_events.notify=1`); no email/SMS is sent. No QR code, no refunds, no real courier, SQLite instead of Postgres (single-node), in-memory rate limiter.

## Demo script (3 min)
1. (0:00) Open from “Instagram”: browse, show live stock, add 2 items; open chat, add another item: cart badge updates in both.
2. (0:45) Checkout with Ibadan delivery (demo rate) → invoice with delivery shown before paying. Try “Other destination” to show manual quote.
3. (1:15) Pay in Naira: show Busha temporary account details/expiry. Send the sandbox deposit.
4. (1:45) Order page flips to Paid with receipt (refresh keeps state). Show underpayment rule (mock scenario, clearly labelled) → AWAITING_BALANCE, shortfall, dispatch blocked.
5. (2:15) `/admin`: see paid order, provider IDs, evidence; Mark packed → add courier/tracking → Dispatch; customer sees tracking.
6. (2:45) Wrap: problem (unconfirmed transfers, overseas customers), Busha rails (bank + stablecoin), one honest limitation.
