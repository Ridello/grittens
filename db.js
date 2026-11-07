import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, price_kobo INTEGER NOT NULL CHECK(price_kobo>0), hue INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS variants(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), size TEXT NOT NULL, colour TEXT NOT NULL, stock INTEGER NOT NULL CHECK(stock>=0), UNIQUE(product_id,size,colour));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cart_items(session_id TEXT NOT NULL REFERENCES sessions(id), variant_id INTEGER NOT NULL REFERENCES variants(id), qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(session_id,variant_id));
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, public_token TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id),
  invoice_no TEXT UNIQUE, recipient_name TEXT, phone TEXT, email TEXT, address TEXT, city TEXT,
  delivery_method TEXT NOT NULL, delivery_fee_kobo INTEGER, quote_pending INTEGER NOT NULL DEFAULT 0,
  subtotal_kobo INTEGER NOT NULL, charges_kobo INTEGER NOT NULL DEFAULT 0, total_kobo INTEGER NOT NULL,
  invoice_json TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  fulfilment_status TEXT NOT NULL DEFAULT 'NONE',
  settlement_status TEXT NOT NULL DEFAULT 'NONE',
  receipt_no TEXT, paid_at TEXT, courier TEXT, tracking TEXT,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), variant_id INTEGER NOT NULL, name TEXT NOT NULL, size TEXT, colour TEXT, unit_price_kobo INTEGER NOT NULL, qty INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reservations(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), variant_id INTEGER NOT NULL REFERENCES variants(id), qty INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'HELD' CHECK(state IN('HELD','COMMITTED','RELEASED')));
CREATE TABLE IF NOT EXISTS attempts(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), internal_ref TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK(method IN('NGN','USDT')), provider TEXT NOT NULL, provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'CREATING', currency TEXT, amount_units TEXT, instructions_json TEXT, provider_raw TEXT,
  expires_at TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt ON attempts(order_id,method) WHERE status IN('CREATING','PENDING');
CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL REFERENCES attempts(id), order_id INTEGER NOT NULL, currency TEXT NOT NULL, amount_units TEXT NOT NULL, evidence_id TEXT NOT NULL UNIQUE, basis TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events(id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, event TEXT, raw TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, order_id INTEGER, kind TEXT NOT NULL, detail TEXT, state TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, text TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS merchants(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
`;

const SEED = [
  ['Ankara Wrap Dress', 'Hand-finished wrap dress in bold Ankara print.', 2800000, 175],
  ['Linen Co-ord Set', 'Breathable two-piece set, relaxed fit.', 3500000, 190],
  ['Adire Print Shirt', 'Indigo adire-inspired short-sleeve shirt.', 1850000, 210],
  ['Wide-Leg Trousers', 'High-waist tailored trousers.', 2200000, 25],
  ['Kaftan Gown', 'Flowing kaftan with embroidered neckline.', 4000000, 160],
  ['Everyday Cotton Tee', 'Heavyweight cotton tee, boxy cut.', 950000, 200],
];

export function openDb(path = process.env.DB_PATH || 'data.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  if (!db.prepare('SELECT 1 FROM products LIMIT 1').get()) {
    const ip = db.prepare('INSERT INTO products(name,description,price_kobo,hue) VALUES(?,?,?,?)');
    const iv = db.prepare('INSERT INTO variants(product_id,size,colour,stock) VALUES(?,?,?,?)');
    SEED.forEach((p, i) => {
      const id = ip.run(...p).lastInsertRowid;
      for (const size of ['S', 'M', 'L']) {
        ['Teal', 'Navy'].forEach((colour, c) => {
          // deterministic stock; the very last variant of product 4 has exactly 1 unit (last-unit demo)
          const stock = i === 3 && size === 'L' && c === 1 ? 1 : 3 + ((i + c + size.length + size.charCodeAt(0)) % 5);
          iv.run(id, size, colour, stock);
        });
      }
    });
  }
  return db;
}
