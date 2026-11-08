require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!PAYSTACK_SECRET_KEY || !ADMIN_TOKEN || !DATABASE_URL) {
  console.error("Missing required environment variables. Check .env.example.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});

// IMPORTANT: Keep prices on the server. Replace these examples with your own prices in pesewas.
// GHS 1.00 = 100 pesewas. Example: pricePesewas: 500 means GH₵5.00.
const BUNDLES = [
  { id: "mtn-1", network: "MTN", name: "MTN 1 GB", size: "1 GB", pricePesewas: 440 },
  { id: "telecel-1", network: "Telecel", name: "Telecel 1 GB", size: "1 GB", pricePesewas: 600 },
  { id: "at-1", network: "AT", name: "AT 1 GB", size: "1 GB", pricePesewas: 500 }
];

function money(pesewas) {
  return (pesewas / 100).toFixed(2);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      network TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      bundle_name TEXT NOT NULL,
      amount_pesewas INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GHS',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      fulfilment_status TEXT NOT NULL DEFAULT 'not_ready',
      paystack_status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      fulfilled_at TIMESTAMPTZ
    )
  `);
}

app.use(express.static(path.join(__dirname, "public")));

// Keep the raw body for Paystack's HMAC signature verification.
app.post("/api/paystack/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.get("x-paystack-signature");
    const digest = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.body).digest("hex");
    if (!signature || !safeEqual(signature, digest)) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "charge.success" && event.data && event.data.reference) {
      // Never trust a webhook payload alone: independently verify the transaction with Paystack.
      await verifyAndMarkPaid(event.data.reference);
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    return res.sendStatus(400);
  }
});

app.use(express.json({ limit: "20kb" }));

app.get("/api/bundles", (req, res) => {
  res.json(BUNDLES.map(b => ({
    id: b.id, network: b.network, name: b.name, size: b.size,
    price: money(b.pricePesewas), currency: "GHS"
  })));
});

app.post("/api/orders", async (req, res) => {
  try {
    const { customerName, email, phone, bundleId } = req.body || {};
    if (!customerName || !email || !phone || !bundleId) {
      return res.status(400).json({ error: "Please complete all required fields." });
    }
    if (String(customerName).trim().length > 100 ||
        String(email).trim().length > 254 ||
        String(phone).trim().length > 30) {
      return res.status(400).json({ error: "One or more fields are too long." });
    }
    const bundle = BUNDLES.find(b => b.id === String(bundleId));
    if (!bundle) return res.status(400).json({ error: "That bundle is not available." });

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPhone = String(phone).trim();
    const reference = `PDBG-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;

    await pool.query(
      `INSERT INTO orders
       (reference, customer_name, email, phone, network, bundle_id, bundle_name, amount_pesewas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [reference, String(customerName).trim(), cleanEmail, cleanPhone,
       bundle.network, bundle.id, bundle.name, bundle.pricePesewas]
    );

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: cleanEmail,
        amount: String(bundle.pricePesewas),
        currency: "GHS",
        reference,
        channels: ["mobile_money"],
        callback_url: `${BASE_URL}/payment-callback`
      })
    });

    const result = await response.json();
    if (!response.ok || !result.status || !result.data?.authorization_url) {
      console.error("Paystack initialization failed:", result.message || response.status);
      return res.status(502).json({ error: "Could not start payment. Please try again later." });
    }

    res.json({ authorizationUrl: result.data.authorization_url, reference });
  } catch (err) {
    console.error("Order creation error:", err.message);
    res.status(500).json({ error: "Could not create your order. Please try again." });
  }
});

// Paystack redirects here after checkout. Redirects do NOT prove payment success;
// the server calls Paystack's Verify Transaction endpoint before updating the order.
app.get("/payment-callback", async (req, res) => {
  const reference = String(req.query.reference || "");
  if (!reference || reference.length > 100) {
    return res.redirect("/?payment=unknown");
  }
  try {
    const outcome = await verifyAndMarkPaid(reference);
    return res.redirect(outcome === "paid" ? "/?payment=received" : "/?payment=pending");
  } catch (err) {
    console.error("Callback verification error:", err.message);
    return res.redirect("/?payment=pending");
  }
});

async function verifyAndMarkPaid(reference) {
  const orderResult = await pool.query("SELECT * FROM orders WHERE reference=$1", [reference]);
  if (!orderResult.rowCount) return "unknown";
  const order = orderResult.rows[0];

  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  const result = await response.json();
  if (!response.ok || !result.status || !result.data) return "pending";

  const tx = result.data;
  const amountMatches = Number(tx.amount) === Number(order.amount_pesewas);
  const currencyMatches = tx.currency === order.currency;
  const referenceMatches = tx.reference === order.reference;

  if (tx.status === "success" && amountMatches && currencyMatches && referenceMatches) {
    // Idempotent: repeated callback/webhook won't reset a completed fulfilment.
    await pool.query(
      `UPDATE orders
       SET payment_status='paid', fulfilment_status=
         CASE WHEN fulfilment_status='not_ready' THEN 'awaiting_fulfilment' ELSE fulfilment_status END,
         paystack_status=$2, paid_at=COALESCE(paid_at, NOW())
       WHERE reference=$1`,
      [reference, tx.status]
    );
    return "paid";
  }

  await pool.query(
    "UPDATE orders SET paystack_status=$2 WHERE reference=$1 AND payment_status <> 'paid'",
    [reference, String(tx.status || "unknown")]
  );
  return "pending";
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token") || "";
  if (!safeEqual(token, ADMIN_TOKEN)) return res.status(401).json({ error: "Admin authentication required." });
  next();
}

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT reference, customer_name, email, phone, network, bundle_name,
              amount_pesewas, currency, payment_status, fulfilment_status,
              created_at, paid_at, fulfilled_at
       FROM orders ORDER BY created_at DESC LIMIT 200`
    );
    res.json(result.rows.map(o => ({
      ...o, amount: money(o.amount_pesewas), amount_pesewas: undefined
    })));
  } catch (err) {
    console.error("Admin orders error:", err.message);
    res.status(500).json({ error: "Could not load orders." });
  }
});

app.post("/api/admin/orders/:reference/fulfil", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE orders SET fulfilment_status='fulfilled', fulfilled_at=NOW()
       WHERE reference=$1 AND payment_status='paid'
       RETURNING reference, fulfilment_status`,
      [req.params.reference]
    );
    if (!result.rowCount) {
      return res.status(409).json({ error: "Order not found or payment has not been verified." });
    }
    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error("Fulfilment update error:", err.message);
    res.status(500).json({ error: "Could not update fulfilment." });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

initDb().then(() => {
  app.listen(PORT, () => console.log(`President's Data Bundles running on port ${PORT}`));
}).catch(err => {
  console.error("Database initialization failed:", err.message);
  process.exit(1);
});
