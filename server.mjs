// server/index.ts
import http from "node:http";
import fs3 from "node:fs";
import path3 from "node:path";
import { randomBytes, randomUUID as randomUUID2, scrypt as scryptCb, timingSafeEqual, createHash as createHash3 } from "node:crypto";
import { promisify } from "node:util";

// server/storage.ts
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
var dataDir = path.resolve(process.env.DATA_DIR || "data");
fs.mkdirSync(dataDir, { recursive: true });
var sqlite = new DatabaseSync(path.join(dataDir, "shopmate.sqlite"));
sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
sqlite.exec(`CREATE TABLE IF NOT EXISTS businesses(id TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS members(email TEXT PRIMARY KEY,business TEXT NOT NULL,role TEXT NOT NULL,sections TEXT NOT NULL DEFAULT '[]');CREATE INDEX IF NOT EXISTS idx_members_business ON members(business);CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,recovery TEXT,created TEXT NOT NULL);CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL,expires INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);CREATE TABLE IF NOT EXISTS invites(email TEXT PRIMARY KEY,business TEXT NOT NULL,hash TEXT NOT NULL,expires INTEGER NOT NULL,role TEXT NOT NULL,sections TEXT NOT NULL);`);
var Statement = class {
  sql;
  args = [];
  constructor(sql) {
    this.sql = sql;
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    return sqlite.prepare(this.sql).get(...this.args) ?? null;
  }
  async all() {
    return { results: sqlite.prepare(this.sql).all(...this.args) };
  }
  async run() {
    const r = sqlite.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes) } };
  }
};
var db = { prepare: (sql) => new Statement(sql) };
var bucket = { async put(key, buffer, opt) {
  const f = path.join(dataDir, "photos", key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(buffer));
  fs.writeFileSync(f + ".meta", JSON.stringify(opt.httpMetadata));
}, async get(key) {
  const base = path.join(dataDir, "photos");
  const f = path.resolve(base, key);
  if (!f.startsWith(base + path.sep) || !fs.existsSync(f)) return null;
  return { body: fs.readFileSync(f), httpMetadata: JSON.parse(fs.readFileSync(f + ".meta", "utf8")) };
} };
var env = { DB: db, BUCKET: bucket };

// shared/products.ts
var normal = (v) => String(v ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
var productKey = (p) => [normal(p.section), normal(p.name), normal(p.unit)].join("|");
function sameProduct(a, b) {
  return productKey(a) === productKey(b) || normal(a.sku) && normal(a.section) === normal(b.section) && normal(a.sku) === normal(b.sku);
}
function validateProduct(a, sections) {
  const errors = [];
  const name = String(a.name ?? "").trim(), unit = normal(a.unit) || "piece";
  const section = sections.find((s) => normal(s) === normal(a.section));
  if (!name || name.length > 150) errors.push("Product name is required (maximum 150 characters).");
  if (!section) errors.push("Section does not match your business.");
  if (!/^[\p{L}\p{N} _-]{1,30}$/u.test(unit)) errors.push("Enter a valid selling unit.");
  const numeric = (k) => {
    const raw = a[k];
    const n = Number(raw);
    if (raw === void 0 || raw === null || String(raw).trim() === "" || !Number.isFinite(n) || n < 0 || n > 1e12) {
      errors.push(k + " must be a non-negative number.");
      return 0;
    }
    return n;
  };
  const quantity = numeric("quantity"), cost = numeric("cost"), price = numeric("price"), threshold = numeric("threshold");
  if (!["kg", "g"].includes(unit) && quantity % 1) errors.push("Opening quantity must be whole items for " + unit + ".");
  const expiry2 = String(a.expiry || "");
  const expiryDate = /* @__PURE__ */ new Date(expiry2 + "T00:00:00Z");
  if (expiry2 && (!Number.isFinite(expiryDate.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry2) || expiryDate.toISOString().slice(0, 10) !== expiry2 || expiry2 < (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }))) errors.push("Expiry must be a valid date that has not passed.");
  return { errors, product: { name, section: section || String(a.section), unit, quantity, cost, price, threshold, sku: String(a.sku || "").trim(), category: String(a.category || "").trim(), expiry: expiry2 } };
}
function previewProducts(rows, existing, sections) {
  if (!Array.isArray(rows) || rows.length > 1e3) throw Error("Import up to 1,000 products at a time.");
  const accepted = [];
  const results = rows.map((row, index) => {
    const checked = validateProduct(row, sections);
    const duplicate = !checked.errors.length && [...existing, ...accepted].some((p) => sameProduct(p, checked.product));
    const status = checked.errors.length ? "Invalid" : duplicate ? "Duplicate" : "Ready";
    if (status === "Ready") accepted.push(checked.product);
    return { row: index + 2, status, errors: checked.errors, product: checked.product };
  });
  return { results, accepted, ready: accepted.length, duplicates: results.filter((x) => x.status === "Duplicate").length, invalid: results.filter((x) => x.status === "Invalid").length };
}

// shared/finance.ts
var cents = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function calculateReport(s, { section = "All sections", from = "", to = "" } = {}) {
  const selected = (x) => section === "All sections" || x.section === section;
  const inRange = (at) => {
    const d = new Date(at).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    return (!from || d >= from) && (!to || d <= to);
  };
  let revenue = 0, cost = 0, returnedLoss = 0;
  for (const sale of s.sales.filter((x) => inRange(x.at))) for (const i of sale.items.filter(selected)) {
    const refunds = (sale.refunds || []).filter((r) => r.product === i.product && (r.itemIndex === void 0 || r.itemIndex === sale.items.indexOf(i)));
    const remaining = 1 - (i.returned || 0) / i.quantity;
    revenue += i.total * remaining;
    cost += (i.cost || 0) * remaining;
    returnedLoss += refunds.filter((r) => !r.resellable).reduce((n, r) => n + (r.cost || 0), 0);
  }
  const expenses = s.expenses.filter((e) => inRange(e.at) && selected(e));
  const expenseTotal = expenses.reduce((n, e) => n + e.amount, 0);
  const gross = revenue - cost;
  return { netSales: cents(revenue), costOfGoodsSold: cents(cost), grossProfit: cents(gross), expenses: cents(expenseTotal), nonResellableReturns: cents(returnedLoss), estimatedOperatingProfit: cents(gross - expenseTotal - returnedLoss), stockValue: cents(s.products.filter(selected).reduce((n, p) => n + p.quantity * p.cost, 0)), sharedExpensesExcluded: section !== "All sections" };
}

// server/shop.ts
var db2 = () => env.DB;
var uid = () => crypto.randomUUID();
var blank = () => ({ name: "My shop", sections: ["Provisions", "Frozen & Other Items"], products: [], sales: [], expenses: [], movements: [], counts: [], audit: [] });
var fail = (s) => {
  throw new Error(s);
};
async function context(req) {
  const user = req.headers.get("oai-authenticated-user-id");
  const email = req.headers.get("oai-authenticated-user-email")?.toLowerCase();
  if (!user || !email) return null;
  const member = await db2().prepare("SELECT * FROM members WHERE email=?").bind(email).first();
  const demo = new URL(req.url).searchParams.get("demo") === "1";
  const id = demo ? user + "-demo" : member?.business || user;
  let row = await db2().prepare("SELECT * FROM businesses WHERE id=?").bind(id).first();
  if (!row) {
    await db2().prepare("INSERT OR IGNORE INTO businesses(id,owner,data,version) VALUES(?,?,?,0)").bind(id, email, JSON.stringify(blank())).run();
    row = await db2().prepare("SELECT * FROM businesses WHERE id=?").bind(id).first();
  }
  return { id, email, role: demo || row.owner === email ? "Owner" : member?.role || "Cashier", sections: JSON.parse(member?.sections || "[]"), row };
}
function visible(c, s) {
  if (c.role === "Owner" || c.role === "Manager") return s;
  return { ...s, products: s.products.filter((p) => c.sections.includes(p.section)).map(({ cost, ...p }) => p), sales: s.sales.filter((x) => x.by === c.email).map(({ cost, ...x }) => ({ ...x, items: x.items.map(({ cost: cost2, ...i }) => i), refunds: x.refunds.map(({ cost: cost2, ...r }) => r) })), expenses: [], movements: [], counts: [], audit: [] };
}
async function GET(req) {
  try {
    const c = await context(req);
    if (!c) return Response.json({ error: "Please sign in with ChatGPT." }, { status: 401 });
    const s = JSON.parse(c.row.data);
    const image = new URL(req.url).searchParams.get("image");
    if (image) {
      if (!image.startsWith(c.id + "/") || c.role === "Cashier" && !s.products.some((p) => p.image === image && c.sections.includes(p.section))) return Response.json({ error: "Forbidden" }, { status: 403 });
      const obj = await env.BUCKET.get(image);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
    }
    const members = c.role === "Owner" ? (await db2().prepare("SELECT email,role,sections FROM members WHERE business=?").bind(c.id).all()).results : [];
    return Response.json({ data: visible(c, s), role: c.role, email: c.email, members, version: c.row.version });
  } catch {
    return Response.json({ error: "Unable to load your shop. Please try again." }, { status: 503 });
  }
}
async function POST(req) {
  try {
    const c = await context(req);
    if (!c) return Response.json({ error: "Sign in required" }, { status: 401 });
    if (req.headers.get("origin") && new URL(req.url).origin !== req.headers.get("origin")) return Response.json({ error: "Invalid request" }, { status: 403 });
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      if (!["Owner", "Manager"].includes(c.role)) return Response.json({ error: "Manager access required" }, { status: 403 });
      const f = (await req.formData()).get("photo");
      if (!f || f.size > 3e6 || !["image/jpeg", "image/png", "image/webp"].includes(f.type)) return Response.json({ error: "Choose a JPG, PNG or WebP under 3 MB" }, { status: 400 });
      const key = c.id + "/" + uid();
      await env.BUCKET.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
      return Response.json({ key });
    }
    const a = await req.json();
    const s = JSON.parse(c.row.data);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const businessDate = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    const owner = () => {
      if (c.role !== "Owner") fail("Only the owner can do this.");
    };
    const manage = () => {
      if (!["Owner", "Manager"].includes(c.role)) fail("Manager access required.");
    };
    const num = (v, min = 0) => {
      const n = Number(v);
      if (v === null || v === void 0 || String(v).trim() === "" || !Number.isFinite(n) || n < min || n > 1e12) fail("Enter a valid amount or quantity.");
      return n;
    };
    const product = (id) => s.products.find((p) => p.id === id) || fail("Product not found");
    const move = (p, q, type, reason, photo = "") => s.movements.unshift({ id: uid(), product: p.id, name: p.name, section: p.section, quantity: q, type, reason, photo, at: now, by: c.email });
    if (a.type === "staff") {
      owner();
      if (!Array.isArray(a.sections) || a.sections.some((x) => !s.sections.includes(x))) fail("Invalid staff sections");
      if (new URL(req.url).searchParams.get("demo") === "1") fail("Staff access is available in your real business.");
      const email = String(a.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === c.row.owner) fail("Enter a different valid staff email.");
      if (!["Manager", "Cashier"].includes(a.role)) fail("Invalid staff role");
      const existing = await db2().prepare("SELECT business FROM members WHERE email=?").bind(email).first();
      if (existing && existing.business !== c.id) fail("This email already belongs to another shop.");
      await db2().prepare("INSERT INTO members(email,business,role,sections) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role,sections=excluded.sections").bind(email, c.id, a.role, JSON.stringify(a.sections || s.sections)).run();
      return Response.json({ ok: true });
    }
    if (a.type === "removeStaff") {
      owner();
      await db2().prepare("DELETE FROM members WHERE email=? AND business=?").bind(a.email, c.id).run();
      return Response.json({ ok: true });
    }
    if (a.type === "settings") {
      owner();
      s.name = String(a.name || "My shop").slice(0, 100);
      if (a.sections) {
        if (!Array.isArray(a.sections) || !a.sections.length) fail("At least one section required");
        s.sections = [...new Set(a.sections.map((x) => String(x).trim()).filter(Boolean))];
        if (s.products.some((p) => !s.sections.includes(p.section))) fail("Move products before removing a section.");
      }
    }
    if (a.type === "product") {
      manage();
      const checked = validateProduct(a, s.sections);
      if (checked.errors.length) fail(checked.errors.join(" "));
      Object.assign(a, checked.product);
      if (s.products.some((p2) => sameProduct(p2, a))) fail("This product already exists. Use Add Stock to receive more goods.");
      if (!s.sections.includes(a.section)) fail("Choose a section");
      const q = num(a.quantity), cost = num(a.cost), price = num(a.price);
      if (!String(a.name || "").trim()) fail("Product name required");
      const unit = String(a.unit || "piece");
      if (a.image && !String(a.image).startsWith(c.id + "/")) fail("Invalid image");
      if (!["kg", "g"].includes(unit) && q % 1) fail("This unit needs a whole quantity");
      const units = [{ name: unit, factor: 1, price }];
      for (const u of a.units || []) {
        if (!u.name || units.some((x) => x.name === u.name)) fail("Unit names must be unique");
        units.push({ name: String(u.name), factor: num(u.factor, 1e-6), price: num(u.price) });
      }
      const p = { id: uid(), name: String(a.name).trim(), category: a.category || "", section: a.section, sku: a.sku || "", image: a.image || "", unit, units, cost, quantity: q, threshold: num(a.threshold), batches: [], expiryTracked: !!a.expiry };
      if (a.expiry) {
        if (a.expiry < businessDate) fail("Opening stock is expired");
        p.batches.push({ id: uid(), quantity: q, expiry: a.expiry });
      }
      s.products.push(p);
      move(p, q, "Opening stock", "Initial physical count");
    }
    if (a.type === "receive") {
      manage();
      const p = product(a.product);
      const u = p.units.find((u2) => u2.name === a.unit) || fail("Invalid unit");
      const q = num(a.quantity, 1e-6) * u.factor;
      const cost = num(a.cost) / u.factor;
      if (!["kg", "g"].includes(p.unit) && q % 1) fail("Quantity must convert to whole items");
      if (p.expiryTracked && !a.expiry) fail("Expiry date required");
      if (a.expiry && a.expiry < businessDate) fail("Cannot receive expired stock");
      p.cost = (p.quantity * p.cost + q * cost) / (p.quantity + q);
      p.quantity += q;
      if (a.expiry) {
        if (!p.expiryTracked && p.quantity - q > 0) fail("Existing untracked stock needs an expiry batch before switching to expiry tracking.");
        p.expiryTracked = true;
        p.batches.push({ id: uid(), quantity: q, expiry: a.expiry });
      }
      move(p, q, "Received", `${a.supplier || "Supplier"} \xB7 ${a.reference || "No invoice reference"}`);
    }
    const deduct = (p, q) => {
      if (p.quantity + 1e-8 < q) fail(`${p.name}: insufficient stock`);
      if (p.expiryTracked) {
        let remaining = q;
        const bs = p.batches.filter((b) => b.expiry >= businessDate).sort((x, y) => x.expiry.localeCompare(y.expiry));
        if (bs.reduce((n, b) => n + b.quantity, 0) + 1e-8 < q) fail(`${p.name}: insufficient unexpired stock`);
        for (const b of bs) {
          const use = Math.min(remaining, b.quantity);
          b.quantity -= use;
          remaining -= use;
        }
      }
      p.quantity = Math.max(0, p.quantity - q);
    };
    if (a.type === "sale") {
      if (s.sales.some((x) => x.id === a.id)) return Response.json({ ok: true, duplicate: true });
      if (!a.id || typeof a.id !== "string" || a.id.length > 100) fail("A valid receipt ID is required");
      if (!Array.isArray(a.items) || !a.items.length) fail("Cart is empty");
      const items = [];
      for (const i of a.items) {
        const p = product(i.product);
        if (c.role === "Cashier" && !c.sections.includes(p.section)) fail("Section not permitted");
        const u = p.units.find((u2) => u2.name === i.unit) || fail("Invalid unit");
        const count = num(i.quantity, 1e-6);
        if (i.price !== void 0 && c.role === "Cashier") fail("Only managers can override prices");
        const price = i.price !== void 0 ? num(i.price) : u.price;
        const q = count * u.factor;
        if (!["kg", "g"].includes(p.unit) && q % 1) fail("Whole quantities required");
        deduct(p, q);
        items.push({ product: p.id, name: p.name, section: p.section, unit: u.name, quantity: count, baseQuantity: q, price, total: cents(count * price), cost: cents(q * p.cost), returned: 0 });
        move(p, -q, "Sale", a.id);
      }
      const subtotal = items.reduce((n, i) => n + i.total, 0);
      const discount = num(a.discount || 0);
      if (discount && c.role === "Cashier") fail("Only managers can discount sales");
      if (discount > subtotal) fail("Discount exceeds sale value");
      for (const i of items) {
        const share = subtotal ? discount * i.total / subtotal : 0;
        i.total -= share;
        i.price = i.total / i.quantity;
      }
      const total = cents(subtotal - discount);
      if (!Array.isArray(a.payments) || a.payments.some((p) => !["Cash", "Bank transfer", "POS/card"].includes(p.method))) fail("Choose a valid payment method");
      const paid = (a.payments || []).reduce((n, x) => n + num(x.amount), 0);
      if (Math.abs(paid - total) > 5e-3) fail("Payments must equal the sale total");
      s.sales.unshift({ id: a.id || uid(), items, total, cost: items.reduce((n, i) => n + i.cost, 0), discount, payments: a.payments, at: now, by: c.email, refunds: [] });
    }
    if (a.type === "return") {
      manage();
      const sale = s.sales.find((x) => x.id === a.sale) || fail("Sale not found");
      const itemIndex = Number(a.index);
      if (!Number.isInteger(itemIndex)) fail("Invalid sale item");
      const i = sale.items[itemIndex] || fail("Item not found");
      const q = num(a.quantity, 1e-6);
      if (!["kg", "g"].includes(product(i.product).unit) && q * i.baseQuantity / i.quantity % 1) fail("Return must convert to whole items");
      if (q > i.quantity - i.returned + 1e-8) fail("Return exceeds remaining sold quantity");
      if (!a.reason) fail("Reason required");
      const p = product(i.product), base = q * i.baseQuantity / i.quantity;
      i.returned += q;
      const refund = { id: uid(), product: i.product, itemIndex, section: i.section, quantity: q, amount: cents(q * i.price), cost: cents(q * i.cost / i.quantity), resellable: !!a.resellable, at: now, reason: a.reason };
      sale.refunds.push(refund);
      if (a.resellable) {
        if (p.expiryTracked && (!a.expiry || a.expiry < businessDate)) fail("Valid expiry required for return");
        p.cost = (p.quantity * p.cost + refund.cost) / (p.quantity + base);
        p.quantity += base;
        if (p.expiryTracked) p.batches.push({ id: uid(), quantity: base, expiry: a.expiry });
        move(p, base, "Return", a.reason);
      } else move(p, 0, "Non-resellable return", a.reason);
    }
    if (a.type === "damage") {
      manage();
      const p = product(a.product), q = num(a.quantity, 1e-6);
      if (!a.reason) fail("Reason required");
      if (!["kg", "g"].includes(p.unit) && q % 1) fail("Whole quantities required");
      if (a.photo && !String(a.photo).startsWith(c.id + "/")) fail("Invalid photo");
      if (q > p.quantity) fail("Insufficient stock");
      p.quantity -= q;
      if (p.expiryTracked) {
        let r = q;
        for (const b of [...p.batches].sort((x, y) => x.expiry.localeCompare(y.expiry))) {
          const u = Math.min(r, b.quantity);
          b.quantity -= u;
          r -= u;
        }
      }
      move(p, -q, "Spoilage / damage", a.reason, a.photo || "");
      s.expenses.unshift({ id: uid(), category: "Stock loss", amount: q * p.cost, section: p.section, at: now, note: a.reason, by: c.email });
    }
    if (a.type === "countStart") {
      manage();
      if (!s.sections.includes(a.section)) fail("Choose a valid section");
      s.counts.unshift({ id: uid(), section: a.section, status: "Counting", at: now, by: c.email, items: s.products.filter((p) => p.section === a.section).map((p) => ({ product: p.id, name: p.name, expected: p.quantity, actual: null })), movementIds: s.movements.map((m) => m.id) });
    }
    if (a.type === "countSubmit") {
      manage();
      const count = s.counts.find((x) => x.id === a.id) || fail("Count not found");
      if (count.status !== "Counting") fail("Count already submitted");
      count.items = count.items.map((i) => ({ ...i, actual: num(a.actual[i.product]) }));
      count.reason = a.reason || "Physical count";
      count.status = "Awaiting approval";
    }
    if (a.type === "countApprove") {
      owner();
      const count = s.counts.find((x) => x.id === a.id) || fail("Count not found");
      if (count.status !== "Awaiting approval") fail("Count is not awaiting approval");
      if (s.movements.some((m) => !count.movementIds.includes(m.id) && m.section === count.section)) fail("Stock changed during this count. Start a fresh count when this section is paused.");
      for (const i of count.items) {
        const p = product(i.product);
        if (p.expiryTracked && i.actual !== p.quantity) fail("For expiry-tracked goods, correct batches through receiving or spoilage, then start a fresh count.");
        if (!["kg", "g"].includes(p.unit) && i.actual % 1) fail("Count must use whole items");
        const delta = i.actual - p.quantity;
        if (delta < 0) s.expenses.unshift({ id: uid(), category: "Stock count loss", amount: -delta * p.cost, section: p.section, at: now, note: count.reason, by: c.email });
        p.quantity = i.actual;
        move(p, delta, "Count adjustment", count.reason);
      }
      count.status = "Approved";
      count.approvedBy = c.email;
    }
    if (a.type === "expense") {
      manage();
      if (a.section && a.section !== "Business" && !s.sections.includes(a.section)) fail("Choose a valid section");
      s.expenses.unshift({ id: uid(), category: a.category || "Other", amount: cents(num(a.amount, 0.01)), section: a.section || "Business", note: a.note || "", at: now, by: c.email });
    }
    if (a.type === "price") {
      owner();
      const p = product(a.product);
      p.units = p.units.map((u) => ({ ...u, price: num(a.prices[u.name]) }));
      p.threshold = num(a.threshold);
      p.name = String(a.name || p.name).trim();
    }
    if (a.type === "transfer") {
      manage();
      const p = product(a.product), q = num(a.quantity, 1e-6);
      if (!s.sections.includes(a.section) || a.section === p.section) fail("Choose a different section");
      const before = p.batches.map((b) => ({ ...b }));
      if (!["kg", "g"].includes(p.unit) && q % 1) fail("Whole quantities required");
      deduct(p, q);
      let dest = s.products.find((d) => d.sourceProduct === p.id && d.section === a.section);
      if (!dest) {
        dest = { ...p, id: uid(), sourceProduct: p.id, section: a.section, quantity: 0, batches: [], units: p.units.map((u) => ({ ...u })) };
        s.products.push(dest);
      }
      dest.cost = (dest.quantity * dest.cost + q * p.cost) / (dest.quantity + q);
      dest.quantity += q;
      for (const b of before) {
        const after = p.batches.find((x) => x.id === b.id);
        const moved = b.quantity - (after?.quantity || 0);
        if (moved > 0) dest.batches.push({ id: uid(), quantity: moved, expiry: b.expiry });
      }
      move(p, -q, "Transfer out", a.section);
      move(dest, q, "Transfer in", p.section);
    }
    if (a.type === "countCancel") {
      manage();
      const count = s.counts.find((x) => x.id === a.id) || fail("Count not found");
      if (count.status === "Approved") fail("Approved counts cannot be cancelled");
      count.status = "Cancelled";
    }
    if (a.type === "report") {
      manage();
      if (a.section && a.section !== "All sections" && !s.sections.includes(a.section)) fail("Choose a valid section");
      return Response.json({ report: calculateReport(s, a) });
    }
    if (a.type === "importPreview" || a.type === "importProducts") {
      manage();
      const preview = previewProducts(a.rows, s.products, s.sections);
      if (a.type === "importPreview") return Response.json({ ...preview, accepted: void 0, version: c.row.version });
      if (a.version !== c.row.version) return Response.json({ error: "Stock changed since your preview. Preview the file again before importing." }, { status: 409 });
      if (preview.invalid) fail("Correct invalid rows before importing.");
      if (!preview.ready) return Response.json({ ok: true, imported: 0, duplicates: preview.duplicates });
      for (const row of preview.accepted) {
        const p = { ...row, id: uid(), units: [{ name: row.unit, factor: 1, price: row.price }], batches: row.expiry ? [{ id: uid(), quantity: row.quantity, expiry: row.expiry }] : [], expiryTracked: !!row.expiry };
        s.products.push(p);
        move(p, row.quantity, "Opening stock", "CSV import");
      }
      s.audit.unshift({ id: uid(), action: "Import products", count: preview.ready, at: now, by: c.email });
      const result2 = await db2().prepare("UPDATE businesses SET data=?,version=version+1 WHERE id=? AND version=?").bind(JSON.stringify(s), c.id, c.row.version).run();
      if (!result2.meta.changes) return Response.json({ error: "Stock changed. Preview again before importing." }, { status: 409 });
      return Response.json({ ok: true, imported: preview.ready, duplicates: preview.duplicates });
    }
    const known = ["price", "transfer", "countCancel", "settings", "product", "receive", "sale", "return", "damage", "countStart", "countSubmit", "countApprove", "expense"];
    if (!known.includes(a.type)) fail("Unknown action");
    s.audit.unshift({ id: uid(), action: a.type, at: now, by: c.email });
    const result = await db2().prepare("UPDATE businesses SET data=?,version=version+1 WHERE id=? AND version=?").bind(JSON.stringify(s), c.id, c.row.version).run();
    if (!result.meta.changes) return Response.json({ error: "Another staff member updated the shop. Refresh and try again." }, { status: 409 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e.message || "Unable to save. Please try again." }, { status: 400 });
  }
}

// server/backups.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { backup, DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { randomUUID, createHash as createHash2 } from "node:crypto";

// server/cloud-backup.ts
import { createHash, createHmac } from "node:crypto";
var hash = (x) => createHash("sha256").update(x).digest("hex");
var mac = (key, value) => createHmac("sha256", key).update(value).digest();
var encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function cloudConfigured() {
  return !!(process.env.BACKUP_ENDPOINT && process.env.BACKUP_BUCKET && process.env.BACKUP_ACCESS_KEY_ID && process.env.BACKUP_SECRET_ACCESS_KEY);
}
function signS3(method, key, body = Buffer.alloc(0), now = /* @__PURE__ */ new Date()) {
  if (!cloudConfigured()) throw Error("Cloud backup is not configured.");
  const endpoint = new URL(process.env.BACKUP_ENDPOINT);
  const bucket2 = process.env.BACKUP_BUCKET;
  const style = process.env.BACKUP_URL_STYLE || "virtual-host";
  const parts = key.split("/").map(encode).join("/");
  if (style === "path") endpoint.pathname = "/" + encode(bucket2) + "/" + parts;
  else {
    endpoint.hostname = bucket2 + "." + endpoint.hostname;
    endpoint.pathname = "/" + parts;
  }
  endpoint.search = "";
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = stamp.slice(0, 8), region = process.env.BACKUP_REGION || "auto";
  const payloadHash = hash(body);
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${endpoint.host}
x-amz-content-sha256:${payloadHash}
x-amz-date:${stamp}
`;
  const canonical = [method, endpoint.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256
${stamp}
${scope}
${hash(canonical)}`;
  const signingKey = mac(mac(mac(mac("AWS4" + process.env.BACKUP_SECRET_ACCESS_KEY, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  return { url: endpoint.href, headers: { "x-amz-date": stamp, "x-amz-content-sha256": payloadHash, Authorization: `AWS4-HMAC-SHA256 Credential=${process.env.BACKUP_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}
async function cloudRequest(method, key, body = Buffer.alloc(0)) {
  const signed = signS3(method, key, body);
  const r = await fetch(signed.url, { method, headers: signed.headers, body: ["PUT", "POST"].includes(method) ? body : void 0, signal: AbortSignal.timeout(3e4) });
  if (!r.ok) throw Error("Cloud backup request failed (" + r.status + ").");
  return Buffer.from(await r.arrayBuffer());
}

// server/backups.ts
var root = path2.join(dataDir, "backups");
fs2.mkdirSync(root, { recursive: true });
var folder = (business) => path2.join(root, "businesses", createHash2("sha256").update(business).digest("hex"));
var latestStatus = path2.join(root, "status.json");
var running = false;
var atomic = (file, value) => {
  fs2.mkdirSync(path2.dirname(file), { recursive: true });
  fs2.writeFileSync(file + ".tmp", value, { mode: 384 });
  fs2.renameSync(file + ".tmp", file);
};
function listBackups(business) {
  const dir = folder(business);
  if (!fs2.existsSync(dir)) return [];
  return fs2.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => {
    const p = JSON.parse(fs2.readFileSync(path2.join(dir, f), "utf8"));
    return { id: p.id, at: p.at, reason: p.reason, version: p.version, products: p.data.products.length, sales: p.data.sales.length, cloud: fs2.existsSync(path2.join(dir, f + ".cloud")) };
  }).sort((a, b) => b.at.localeCompare(a.at));
}
function readBusinessBackup(business, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("Invalid backup reference.");
  const file = path2.join(folder(business), id + ".json");
  if (!fs2.existsSync(file)) throw Error("Backup not found for your business.");
  const p = JSON.parse(fs2.readFileSync(file, "utf8"));
  if (p.format !== "shopmate-business-v1" || p.business !== business) throw Error("Backup does not belong to this business.");
  if (!Array.isArray(p.data.products) || !Array.isArray(p.data.sales)) throw Error("Backup is invalid.");
  return p;
}
async function snapshotBusiness(row, reason = "Manual backup") {
  const payload = { format: "shopmate-business-v1", id: randomUUID(), business: row.id, at: (/* @__PURE__ */ new Date()).toISOString(), reason, version: row.version, data: JSON.parse(row.data) };
  const file = path2.join(folder(row.id), payload.id + ".json");
  atomic(file, JSON.stringify(payload));
  readBusinessBackup(row.id, payload.id);
  if (cloudConfigured()) {
    try {
      await cloudRequest("PUT", "businesses/" + path2.basename(folder(row.id)) + "/" + payload.id + ".json", fs2.readFileSync(file));
      atomic(file + ".cloud", "saved");
    } catch (e) {
      console.error("Business cloud backup failed:", e.message);
    }
  }
  return payload;
}
function backupStatus(business) {
  let status = {};
  try {
    status = JSON.parse(fs2.readFileSync(latestStatus, "utf8"));
  } catch {
  }
  const list = listBackups(business);
  return { lastBusinessBackup: list[0] || null, lastAutomaticBackup: status.at || null, lastCloudBackup: status.cloudAt || null, cloudConfigured: cloudConfigured(), lastError: status.error || null, retentionDays: 30 };
}
async function photosToCloud() {
  const dir = path2.join(dataDir, "photos");
  if (!cloudConfigured() || !fs2.existsSync(dir)) return;
  const walk = (d) => fs2.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path2.join(d, e.name)) : [path2.join(d, e.name)]);
  for (const f of walk(dir)) {
    if (f.endsWith(".cloud")) continue;
    const marker = path2.join(root, "photo-markers", createHash2("sha256").update(f).digest("hex"));
    if (fs2.existsSync(marker)) continue;
    await cloudRequest("PUT", "photos/" + path2.relative(dir, f).split(path2.sep).join("/"), fs2.readFileSync(f));
    atomic(marker, "saved");
  }
}
async function runAutomaticBackup() {
  if (running) return;
  running = true;
  let at = (/* @__PURE__ */ new Date()).toISOString();
  let status = { at: null, cloudAt: null, error: null };
  try {
    try {
      status = JSON.parse(fs2.readFileSync(latestStatus, "utf8"));
    } catch {
    }
    const rows = sqlite.prepare("SELECT * FROM businesses").all();
    for (const row of rows) {
      const last = listBackups(row.id)[0];
      if (!last || last.version !== row.version) await snapshotBusiness(row, "Automatic backup");
      const dir = folder(row.id);
      if (fs2.existsSync(dir)) for (const file of fs2.readdirSync(dir).filter((x) => /^[0-9a-f-]{36}\.json$/.test(x))) {
        if (!fs2.existsSync(path2.join(dir, file + ".cloud")) && cloudConfigured()) {
          await cloudRequest("PUT", "businesses/" + path2.basename(dir) + "/" + file, fs2.readFileSync(path2.join(dir, file)));
          atomic(path2.join(dir, file + ".cloud"), "saved");
        }
      }
    }
    const dbFile = path2.join(root, "database-" + at.slice(0, 10) + ".sqlite");
    await backup(sqlite, dbFile);
    const verify = new DatabaseSync2(dbFile, { readOnly: true });
    try {
      const check = verify.prepare("PRAGMA integrity_check").get();
      if (check.integrity_check !== "ok") throw Error("Backup integrity check failed.");
    } finally {
      verify.close();
    }
    if (cloudConfigured()) {
      const bytes = fs2.readFileSync(dbFile), key = "databases/" + path2.basename(dbFile);
      await cloudRequest("PUT", key, bytes);
      const recovered = await cloudRequest("GET", key);
      if (!createHash2("sha256").update(bytes).digest().equals(createHash2("sha256").update(recovered).digest())) throw Error("Cloud backup verification failed.");
      await photosToCloud();
      status.cloudAt = at;
      console.log("Automatic cloud database backup uploaded and recovery copy verified.");
    }
    status.at = at;
    status.error = null;
    const cutoff = Date.now() - 30 * 864e5;
    for (const row of rows) {
      const snapshots = listBackups(row.id);
      for (const b of snapshots.slice(1).filter((b2) => new Date(b2.at).getTime() < cutoff)) {
        const file = path2.join(folder(row.id), b.id + ".json");
        if (cloudConfigured()) await cloudRequest("DELETE", "businesses/" + path2.basename(folder(row.id)) + "/" + b.id + ".json");
        fs2.rmSync(file, { force: true });
        fs2.rmSync(file + ".cloud", { force: true });
      }
    }
    for (const f of fs2.readdirSync(root).filter((x) => /^database-\d{4}-\d{2}-\d{2}\.sqlite$/.test(x))) {
      if (new Date(f.slice(9, 19)).getTime() < cutoff) {
        if (cloudConfigured()) await cloudRequest("DELETE", "databases/" + f);
        fs2.rmSync(path2.join(root, f), { force: true });
      }
    }
  } catch (e) {
    status.error = "An automatic backup failed. Your current records are still saved; retry a backup or contact Jathan Global.";
    console.error("Automatic backup failed:", e.message);
  } finally {
    atomic(latestStatus, JSON.stringify(status));
    running = false;
  }
}
function startBackups() {
  if (process.env.BACKUP_DISABLED === "true") return;
  setTimeout(() => void runAutomaticBackup(), 2e3).unref();
  setInterval(() => void runAutomaticBackup(), Number(process.env.BACKUP_INTERVAL_MS) || 36e5).unref();
}

// server/index.ts
var scrypt = promisify(scryptCb);
var sha = (v) => createHash3("sha256").update(v).digest("hex");
var json = (v, status = 200) => Response.json(v, { status });
var port = Number(process.env.PORT || 3e3);
var client = path3.resolve("dist/client");
var secure = process.env.SECURE_COOKIE === "true";
var expiry = () => Date.now() + 7 * 864e5;
var limits = /* @__PURE__ */ new Map();
function rate(ip) {
  const now = Date.now();
  if (limits.size > 1e4) {
    for (const [k, v] of limits) if (v.until < now) limits.delete(k);
  }
  let x = limits.get(ip);
  if (!x || x.until < now) {
    x = { n: 0, until: now + 6e4 };
    limits.set(ip, x);
  }
  return ++x.n <= (Number(process.env.AUTH_RATE_LIMIT) || 12);
}
async function hashPassword(v) {
  const salt = randomBytes(16).toString("hex");
  const hash2 = await scrypt(v, salt, 64);
  return salt + ":" + hash2.toString("hex");
}
async function matches(v, stored) {
  const [salt, hash2] = stored.split(":");
  const b = await scrypt(v, salt, 64);
  const a = Buffer.from(hash2, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
var passwordValid = (v) => typeof v === "string" && v.length >= 10 && v.length <= 128;
var cookie = (token, max = 7 * 86400) => `shopmate_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${max}${secure ? "; Secure" : ""}`;
function sessionUser(req) {
  const token = (req.headers.get("cookie") || "").match(/(?:^|;\s*)shopmate_session=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) return null;
  return sqlite.prepare("SELECT users.id,users.email,users.name FROM sessions JOIN users ON users.id=sessions.user WHERE sessions.token=? AND sessions.expires>?").get(sha(token), Date.now()) || null;
}
function startSession(user) {
  const token = randomBytes(32).toString("base64url");
  sqlite.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
  sqlite.prepare("INSERT INTO sessions(token,user,expires) VALUES(?,?,?)").run(sha(token), user.id, expiry());
  return new Response(JSON.stringify({ user: { id: user.id, email: user.email, name: user.name } }), { headers: { "Content-Type": "application/json", "Set-Cookie": cookie(token) } });
}
function inviteFor(email, code) {
  const i = sqlite.prepare("SELECT * FROM invites WHERE email=? AND expires>?").get(email, Date.now());
  if (!i || !code || sha(code) !== i.hash) throw Error("The invitation code is invalid or expired.");
  return i;
}
function activate(user, i) {
  sqlite.prepare("INSERT INTO members(email,business,role,sections) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET business=excluded.business,role=excluded.role,sections=excluded.sections").run(user.email, i.business, i.role, i.sections);
  sqlite.prepare("DELETE FROM invites WHERE email=?").run(user.email);
}
async function auth(req, ip) {
  const route = new URL(req.url).pathname;
  const user = sessionUser(req);
  if (route === "/api/auth/me") return json({ user });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (route === "/api/auth/logout") {
    const token = (req.headers.get("cookie") || "").match(/shopmate_session=([A-Za-z0-9_-]+)/)?.[1];
    if (token) sqlite.prepare("DELETE FROM sessions WHERE token=?").run(sha(token));
    return new Response("{}", { headers: { "Content-Type": "application/json", "Set-Cookie": cookie("", 0) } });
  }
  if (route === "/api/auth/recovery") {
    if (!user) return json({ error: "Sign in required" }, 401);
    const code = randomBytes(24).toString("base64url");
    sqlite.prepare("UPDATE users SET recovery=? WHERE id=?").run(sha(code), user.id);
    return json({ code });
  }
  if (!rate(ip)) return json({ error: "Too many attempts. Please wait a minute." }, 429);
  if (!req.headers.get("content-type")?.includes("application/json")) return json({ error: "Invalid request" }, 400);
  const a = await req.json();
  const email = String(a.email || "").trim().toLowerCase();
  if (route === "/api/auth/accept-invite") {
    if (!user) return json({ error: "Sign in required" }, 401);
    const i = inviteFor(user.email, String(a.code || ""));
    activate(user, i);
    return json({ ok: true });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "Enter a valid email." }, 400);
  const row = sqlite.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (route === "/api/auth/signup") {
    if (!passwordValid(a.password)) return json({ error: "Use a password with 10 to 128 characters." }, 400);
    if (row) return json({ error: "This email is registered. Sign in or use your recovery code." }, 409);
    if (!String(a.name || "").trim()) return json({ error: "Enter your name." }, 400);
    let invite = null;
    if (a.invite) invite = inviteFor(email, String(a.invite));
    const id = randomUUID2(), password = await hashPassword(a.password);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.prepare("INSERT INTO users(id,email,name,password,created) VALUES(?,?,?,?,?)").run(id, email, String(a.name).trim().slice(0, 100), password, (/* @__PURE__ */ new Date()).toISOString());
      if (invite) activate({ email }, invite);
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
    return startSession({ id, email, name: a.name });
  }
  if (route === "/api/auth/login") {
    if (typeof a.password !== "string" || a.password.length > 128) return json({ error: "Incorrect email or password." }, 401);
    const dummy = "8fac43c1b24b23017f673f4923a4afea:" + "0".repeat(128);
    const valid = await matches(a.password, row?.password || dummy);
    if (!row || !valid) return json({ error: "Incorrect email or password." }, 401);
    return startSession(row);
  }
  if (route === "/api/auth/reset") {
    if (!passwordValid(a.password)) return json({ error: "Use a password with 10 to 128 characters." }, 400);
    if (!row?.recovery || sha(String(a.recovery || "")) !== row.recovery) return json({ error: "Incorrect email or recovery code." }, 400);
    const password = await hashPassword(a.password);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.prepare("UPDATE users SET password=?,recovery=NULL WHERE id=?").run(password, row.id);
      sqlite.prepare("DELETE FROM sessions WHERE user=?").run(row.id);
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}
async function shop(req) {
  const user = sessionUser(req);
  if (!user) return json({ error: "Sign in required" }, 401);
  const h = new Headers(req.headers);
  h.delete("oai-authenticated-user-id");
  h.delete("oai-authenticated-user-email");
  h.set("oai-authenticated-user-id", user.id);
  h.set("oai-authenticated-user-email", user.email);
  let body;
  if (req.method !== "GET") body = new Uint8Array(await req.arrayBuffer());
  const trusted = new Request(req.url, { method: req.method, headers: h, body });
  if (req.method === "POST" && h.get("content-type")?.includes("application/json")) {
    const a = JSON.parse(Buffer.from(body).toString());
    if (a.type === "staff") {
      if (new URL(req.url).searchParams.get("demo") === "1") return json({ error: "Use your real business for staff invitations." }, 400);
      const member = sqlite.prepare("SELECT * FROM members WHERE email=?").get(user.email);
      const id = member?.business || user.id;
      const b = sqlite.prepare("SELECT owner FROM businesses WHERE id=?").get(id);
      if (b?.owner !== user.email) return json({ error: "Owner access required" }, 403);
      const email = String(a.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === user.email || !["Manager", "Cashier"].includes(a.role)) return json({ error: "Enter a valid staff email and role" }, 400);
      const active = sqlite.prepare("SELECT business FROM members WHERE email=?").get(email);
      if (active?.business === id) return POST(trusted);
      if (active) return json({ error: "Staff already belong to another business." }, 400);
      const code = randomBytes(20).toString("base64url");
      sqlite.prepare("INSERT INTO invites(email,business,hash,expires,role,sections) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET business=excluded.business,hash=excluded.hash,expires=excluded.expires,role=excluded.role,sections=excluded.sections").run(email, id, sha(code), expiry(), a.role, JSON.stringify(a.sections || []));
      return json({ ok: true, invite: code });
    }
  }
  if (req.method === "GET") {
    const r = await GET(trusted);
    if (!r.ok || new URL(req.url).searchParams.has("image")) return r;
    const j = await r.json();
    if (j.role === "Owner") {
      const member = sqlite.prepare("SELECT business FROM members WHERE email=?").get(user.email);
      const id = member?.business || user.id;
      if (new URL(req.url).searchParams.get("demo") !== "1") {
        const pending = sqlite.prepare("SELECT email,role,sections FROM invites WHERE business=? AND expires>?").all(id, Date.now());
        j.members.push(...pending.map((x) => ({ ...x, role: x.role + " (invited)" })));
      }
    }
    return json(j);
  }
  if (req.method === "POST") {
    const a = h.get("content-type")?.includes("application/json") ? JSON.parse(Buffer.from(body).toString()) : null;
    const r = await POST(trusted);
    if (r.ok && a?.type === "removeStaff") {
      const member = sqlite.prepare("SELECT business FROM members WHERE email=?").get(user.email);
      sqlite.prepare("DELETE FROM invites WHERE email=? AND business=?").run(a.email, member?.business || user.id);
    }
    return r;
  }
  return json({ error: "Method not allowed" }, 405);
}
async function backups(req) {
  const user = sessionUser(req);
  if (!user) return json({ error: "Sign in required" }, 401);
  const h = new Headers();
  h.set("oai-authenticated-user-id", user.id);
  h.set("oai-authenticated-user-email", user.email);
  const c = await context(new Request(req.url, { headers: h }));
  if (!c || c.role !== "Owner") return json({ error: "Only the business owner can access backups." }, 403);
  const url = new URL(req.url);
  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      const b = readBusinessBackup(c.id, id);
      return json({ backup: { id: b.id, at: b.at, reason: b.reason, products: b.data.products.length, sales: b.data.sales.length, expenses: b.data.expenses.length }, version: c.row.version, businessName: JSON.parse(c.row.data).name });
    }
    return json({ backups: listBackups(c.id), status: backupStatus(c.id), version: c.row.version });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const a = await req.json();
  if (a.type === "create") {
    const b = await snapshotBusiness(c.row);
    return json({ ok: true, id: b.id, status: backupStatus(c.id) });
  }
  if (a.type === "restore") {
    const current = JSON.parse(c.row.data);
    if (a.version !== c.row.version) return json({ error: "Your shop changed. Review the restore again before confirming." }, 409);
    if (a.confirm !== current.name) return json({ error: "Type your current business name to confirm the restore." }, 400);
    const b = readBusinessBackup(c.id, String(a.id));
    for (const p of b.data.products) {
      if (p.image && !p.image.startsWith(c.id + "/")) return json({ error: "Backup has an invalid photo reference." }, 400);
    }
    await snapshotBusiness(c.row, "Before restore");
    b.data.audit.unshift({ id: randomUUID2(), action: "Restore backup", backup: a.id, at: (/* @__PURE__ */ new Date()).toISOString(), by: c.email });
    const r = sqlite.prepare("UPDATE businesses SET data=?,version=version+1 WHERE id=? AND version=?").run(JSON.stringify(b.data), c.id, c.row.version);
    if (!r.changes) return json({ error: "Your shop changed during restore. No records were replaced." }, 409);
    return json({ ok: true, status: backupStatus(c.id) });
  }
  return json({ error: "Unknown backup action" }, 400);
}
var mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
var server = http.createServer(async (incoming, out) => {
  try {
    const origin = process.env.PUBLIC_ORIGIN || "http://" + incoming.headers.host;
    const url = new URL(incoming.url || "/", origin);
    const headers = new Headers();
    for (const [k, v] of Object.entries(incoming.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    headers.delete("oai-authenticated-user-id");
    headers.delete("oai-authenticated-user-email");
    if (incoming.method === "POST" && headers.get("origin") && headers.get("origin") !== new URL(origin).origin) {
      out.writeHead(403, { "Content-Type": "application/json" });
      out.end(JSON.stringify({ error: "Invalid request origin" }));
      return;
    }
    let size = 0;
    const chunks = [];
    for await (const c of incoming) {
      const b = Buffer.from(c);
      size += b.length;
      if (size > 4 * 1024 * 1024) {
        out.writeHead(413);
        out.end("Request too large");
        return;
      }
      chunks.push(b);
    }
    const req = new Request(url, { method: incoming.method, headers, body: ["GET", "HEAD"].includes(incoming.method || "GET") ? void 0 : Buffer.concat(chunks) });
    let r;
    if (url.pathname.startsWith("/api/auth/")) r = await auth(req, incoming.socket.remoteAddress || "unknown");
    else if (url.pathname === "/api/backups") r = await backups(req);
    else if (url.pathname === "/api/shop") r = await shop(req);
    else if (url.pathname === "/health") r = json({ ok: true });
    else {
      let file = path3.resolve(client, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(client + path3.sep) && file !== client) r = new Response("Not found", { status: 404 });
      else {
        if (!fs3.existsSync(file) || fs3.statSync(file).isDirectory()) file = path3.join(client, "index.html");
        r = new Response(fs3.readFileSync(file), { headers: { "Content-Type": mime[path3.extname(file)] || "application/octet-stream", "Cache-Control": url.pathname.startsWith("/assets/") ? "public,max-age=31536000,immutable" : "no-cache" } });
      }
    }
    const responseHeaders = Object.fromEntries(r.headers);
    responseHeaders["X-Content-Type-Options"] = "nosniff";
    responseHeaders["Referrer-Policy"] = "same-origin";
    responseHeaders["X-Frame-Options"] = "DENY";
    responseHeaders["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    if (url.pathname.startsWith("/api/")) responseHeaders["Cache-Control"] = "no-store";
    out.writeHead(r.status, responseHeaders);
    out.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error("Request failed:", e.message);
    out.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    out.end(JSON.stringify({ error: "Unable to complete the request. Please try again." }));
  }
});
server.listen(port, "0.0.0.0", () => console.log("Jathan ShopMate listening on port " + port));
startBackups();
var shutdown = () => server.close(() => {
  sqlite.close();
  process.exit(0);
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
