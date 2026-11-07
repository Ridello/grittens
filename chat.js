import { AppError, DELIVERY } from './services.js';

const naira = (k) => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: k % 100 ? 2 : 0 });
const MENU = [
  { label: 'Browse Products', action: 'browse' }, { label: 'Check Stock', action: 'stock_form' }, { label: 'View Cart', action: 'cart' },
  { label: 'Delivery Options', action: 'delivery' }, { label: 'View My Order', action: 'orders' },
];

// Chat is only a thin interface: every action calls the same services the storefront uses.
export function makeChat(svc) {
  const caps = () => svc.provider.capabilities();
  function payButtons(o) {
    const out = [];
    if (['UNPAID', 'PENDING', 'AWAITING_BALANCE'].includes(o.payment_status) && !o.quote_pending) {
      const c = caps();
      for (const [m, label] of [['NGN', 'Pay in Naira'], ['USDT', 'Pay in USDT']]) if (c[m].enabled) out.push({ label, action: 'pay', args: { token: o.token, method: m } });
    }
    out.push({ label: 'Refresh status', action: 'refresh', args: { token: o.token } });
    out.push({ label: 'Open order page', href: '#/order/' + o.token });
    return out;
  }
  function orderText(o) {
    let t = `${o.display_id} · ${o.invoice_no}\nTotal: ${naira(o.total_kobo)}\nPayment: ${o.payment_status}${o.quote_pending ? ' (waiting for delivery quote)' : ''}\nFulfilment: ${o.fulfilment_status}`;
    const a = [...o.attempts].reverse().find((x) => x.status === 'PENDING');
    if (a?.instructions) {
      const i = a.instructions;
      t += i.type === 'bank_transfer'
        ? `\n\nPay exactly ${i.currency} ${a.amount} to ${i.bank_name}, account ${i.account_number} (${i.account_name}). Expires ${a.expires_at}.${i.simulated ? '\n[SIMULATED]' : ''}`
        : `\n\nSend exactly ${a.amount} USDT on ${i.network} to ${i.address}. Expires ${a.expires_at}.${i.simulated ? '\n[SIMULATED]' : ''}`;
    }
    if (o.payment_status === 'AWAITING_BALANCE') { const p = o.attempts.find((x) => x.shortfall !== '0'); if (p) t += `\n\nShortfall: ${p.shortfall} ${p.currency}. Dispatch is blocked until resolved.`; }
    if (o.receipt_no) t += `\n\nReceipt ${o.receipt_no} issued.`;
    if (o.tracking) t += `\nCourier: ${o.courier}, tracking ${o.tracking}`;
    return t;
  }

  return async function chat(sid, action = 'menu', args = {}) {
    const msgs = [];
    const say = (text, buttons, extra = {}) => msgs.push({ text, buttons, ...extra });
    try {
      switch (action) {
        case 'menu': say('Welcome to Amaka’s Closet. I can help you find clothes, check stock, arrange delivery, and pay in naira or USDT.', MENU); break;
        case 'browse': {
          const ps = svc.listProducts();
          say('Here is what we have right now:', ps.map((p) => ({ label: `${p.name} — ${naira(p.price_kobo)}`, action: 'product', args: { id: p.id } })));
          break;
        }
        case 'stock_form': say('Which item do you want to check?', null, { form: { action: 'stock', fields: [{ name: 'q', label: 'Product name (blank = all)', type: 'text' }], submit: 'Check' } }); break;
        case 'stock': {
          const ps = svc.listProducts(args.q);
          if (!ps.length) { say('No product matches that name.', MENU); break; }
          say(ps.map((p) => `${p.name}: ${p.variants.filter((v) => v.available > 0).map((v) => `${v.size}/${v.colour} (${v.available})`).join(', ') || 'out of stock'}`).join('\n'), ps.slice(0, 5).map((p) => ({ label: 'View ' + p.name, action: 'product', args: { id: p.id } })));
          break;
        }
        case 'product': {
          const p = svc.listProducts().find((x) => x.id === Number(args.id));
          if (!p) throw new AppError('Product not found', 404);
          const ok = p.variants.filter((v) => v.available > 0);
          say(`${p.name} — ${naira(p.price_kobo)}\n${p.description}`, null, ok.length ? { form: { action: 'add', fields: [{ name: 'variantId', label: 'Size / colour', type: 'select', options: ok.map((v) => ({ value: v.id, label: `${v.size} / ${v.colour} (${v.available} left)` })) }, { name: 'qty', label: 'Quantity', type: 'number', value: 1 }], submit: 'Add to cart' } } : {});
          if (!ok.length) say('Sorry, this item is out of stock.', MENU);
          break;
        }
        case 'add': { svc.cartAdd(sid, Number(args.variantId), Number(args.qty) || 1); const c = svc.cartGet(sid); say(`Added. Cart: ${c.count} item(s), subtotal ${naira(c.subtotal_kobo)}.`, [{ label: 'View Cart', action: 'cart' }, { label: 'Keep browsing', action: 'browse' }, { label: 'Checkout', href: '#/checkout' }]); break; }
        case 'setqty': { svc.cartSet(sid, Number(args.variantId), Number(args.qty)); return chat(sid, 'cart'); }
        case 'cart': {
          const c = svc.cartGet(sid);
          if (!c.items.length) { say('Your cart is empty.', [{ label: 'Browse Products', action: 'browse' }]); break; }
          say(c.items.map((i) => `${i.qty} × ${i.name} (${i.size}/${i.colour}) — ${naira(i.line_kobo)}`).join('\n') + `\n\nSubtotal: ${naira(c.subtotal_kobo)} (delivery added at checkout)`,
            [...c.items.map((i) => ({ label: `Remove ${i.name} ${i.size}/${i.colour}`, action: 'setqty', args: { variantId: i.variant_id, qty: 0 } })), { label: 'Delivery & checkout', href: '#/checkout' }]);
          break;
        }
        case 'delivery': say('Delivery options (rates are DEMO rates, not real courier pricing):\n' + Object.values(DELIVERY).map((d) => `• ${d.label}: ${d.fee === null ? 'quoted by Amaka' : d.fee ? naira(d.fee) : 'free'}`).join('\n'), [{ label: 'Open delivery step', href: '#/checkout' }]); break;
        case 'orders': {
          const os = svc.sessionOrders(sid);
          if (!os.length) { say('You have no orders in this session yet.', MENU); break; }
          say('Your orders:', os.map((o) => ({ label: `${o.display_id} · ${o.payment_status}`, action: 'order', args: { token: o.token } })));
          break;
        }
        case 'order': { const o = svc.orderByTokenView(args.token); if (!sessionOwns(o)) throw new AppError('Order not found', 404); say(orderText(o), payButtons(o)); break; }
        case 'pay': { const o = await svc.createPayment(args.token, args.method); say(orderText(o), payButtons(o)); break; }
        case 'refresh': { const o = await svc.refreshOrder(args.token); say(orderText(o), payButtons(o)); break; }
        default: throw new AppError('Unknown action');
      }
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      say('⚠ ' + e.message, MENU);
    }
    return { messages: msgs };
    function sessionOwns(o) { return svc.sessionOrders(sid).some((x) => x.id === o.id); }
  };
}
