require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'P9x4uF2q7sL8vYz1bR3cM0nT5wK6aD9eH1jV7pQ2uS4yZ8';

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 10,
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de Postgres:', err.message);
});

// ================= HEALTH CHECK =================
app.get('/api/health', async (req, res) => {
  try {
    const db = await pool.query(`
      SELECT current_database() AS database, COUNT(*) AS total_products FROM products
    `);
    res.json({
      status: 'ok',
      database: db.rows[0].database,
      total_products: db.rows[0].total_products,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ================= AUTH =================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });

    const user = result.rows[0];
    if (password !== user.password_hash)
      return res.status(401).json({ error: 'Contraseña incorrecta' });

    const token = jwt.sign(
      { id: user.id, org_id: user.org_id, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, user: { id: user.id, name: user.name, org_id: user.org_id } });
  } catch (error) {
    res.status(500).json({ error: 'Error en login' });
  }
});

// ================= ORGANIZACIONES =================
app.get('/api/organizations', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, rfc, plan_type FROM organizations WHERE is_active = TRUE ORDER BY name`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= PRODUCTOS =================
app.get('/api/products/search', async (req, res) => {
  const { q, org_id } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT id, sku, name, price_with_tax AS price, unit_type, pieces_per_box
       FROM v_products_full
       WHERE org_id = $1 AND is_active = TRUE
         AND (sku ILIKE $2 OR name ILIKE $2)
       ORDER BY name
       LIMIT 10`,
      [org_id || 1, `%${q.trim()}%`]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products/reorder', async (req, res) => {
  const { org_id, warehouse_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT 
         p.id, p.sku, p.name, p.stock_alert_limit, p.unit_type,
         COALESCE(i.quantity, 0) AS current_stock,
         COALESCE(i.quantity, 0) - p.stock_alert_limit AS difference,
         pp.name AS primary_provider_name,
         pp.id AS primary_provider_id
       FROM v_products_full p
       LEFT JOIN inventory i 
         ON i.product_id = p.id AND i.org_id = p.org_id AND i.warehouse_id = $2
       LEFT JOIN provider_products prvp 
         ON prvp.product_id = p.id AND prvp.org_id = p.org_id AND prvp.is_primary = TRUE
       LEFT JOIN providers pp ON pp.id = prvp.provider_id
       WHERE p.org_id = $1 AND p.is_active = TRUE
         AND COALESCE(i.quantity, 0) <= p.stock_alert_limit
       ORDER BY difference ASC`,
      [org_id || 1, warehouse_id || 1]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products/:sku', async (req, res) => {
  const { sku } = req.params;
  const { org_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT id, sku, name, price_with_tax AS price, price_no_tax, cost_no_tax,
              profit, profit_pct, unit_type, pieces_per_box
       FROM v_products_full
       WHERE sku = $1 AND org_id = $2 AND is_active = TRUE`,
      [sku, org_id || 1]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Producto no encontrado' });

    if (!result.rows[0].price || Number(result.rows[0].price) === 0)
      return res.status(422).json({
        error: 'Producto sin precio configurado',
        product: result.rows[0]
      });

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products', async (req, res) => {
  const {
    sku, name, description, category, unit_type, pieces_per_box,
    stock_alert_limit, org_id, cost_no_tax, price_no_tax,
    price_with_tax, tax_rate, user_id
  } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query(
      `INSERT INTO products (sku, name, description, category, unit_type, pieces_per_box, stock_alert_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [sku, name, description || null, category || null,
       unit_type || 'pieza', pieces_per_box || 1, stock_alert_limit || 5]
    );
    const productId = prodRes.rows[0].id;

    await client.query(
      `INSERT INTO organization_products (org_id, product_id) VALUES ($1,$2)`,
      [org_id, productId]
    );

    if (price_with_tax || price_no_tax) {
      const priceSinIva  = price_no_tax  || (price_with_tax / 1.16);
      const precioConIva = price_with_tax || (price_no_tax  * 1.16);
      const profit       = priceSinIva - (cost_no_tax || 0);
      const profitPct    = cost_no_tax > 0 ? (profit / cost_no_tax) * 100 : 0;

      await client.query(
        `INSERT INTO product_prices
         (sku, product_id, org_id, cost_no_tax, price_no_tax, price_with_tax, tax_rate, profit, profit_pct, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sku, productId, org_id, cost_no_tax || 0, priceSinIva,
         precioConIva, tax_rate || 16, profit, profitPct, user_id || null]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, productId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ================= MÉTODOS DE PAGO =================
app.get('/api/payment-methods', async (req, res) => {
  const { org_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT id, name FROM payment_methods
       WHERE (org_id = $1 OR org_id IS NULL) AND is_active = TRUE
       ORDER BY id`,
      [org_id || 1]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= PROVEEDORES =================
app.get('/api/providers', async (req, res) => {
  const { org_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM providers WHERE org_id = $1 ORDER BY name`,
      [org_id || 1]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/providers', async (req, res) => {
  const { org_id, name, contact_phone, email, address, rfc, business_name, zip_code, tax_regime } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO providers (org_id, name, contact_phone, email, address, rfc, business_name, zip_code, tax_regime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [org_id, name, contact_phone || null, email || null, address || null,
       rfc || null, business_name || null, zip_code || null, tax_regime || null]
    );
    res.json({ success: true, providerId: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/providers/:id', async (req, res) => {
  const { id } = req.params;
  const { name, contact_phone, email, address, rfc, business_name, zip_code, tax_regime } = req.body;
  try {
    await pool.query(
      `UPDATE providers SET name=$1, contact_phone=$2, email=$3, address=$4,
       rfc=$5, business_name=$6, zip_code=$7, tax_regime=$8 WHERE id=$9`,
      [name, contact_phone || null, email || null, address || null,
       rfc || null, business_name || null, zip_code || null, tax_regime || null, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= CLIENTES =================
app.get('/api/customers', async (req, res) => {
  const { org_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM customers WHERE org_id = $1 AND is_active = TRUE ORDER BY name`,
      [org_id || 1]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/customers', async (req, res) => {
  const { org_id, name, rfc, business_name, email, phone, address, zip_code, tax_regime } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO customers (org_id, name, rfc, business_name, email, phone, address, zip_code, tax_regime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [org_id, name, rfc || null, business_name || null, email || null,
       phone || null, address || null, zip_code || null, tax_regime || null]
    );
    res.json({ success: true, customerId: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/customers/:id', async (req, res) => {
  const { id } = req.params;
  const { name, rfc, business_name, email, phone, address, zip_code, tax_regime, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE customers SET name=$1, rfc=$2, business_name=$3, email=$4,
       phone=$5, address=$6, zip_code=$7, tax_regime=$8, is_active=$9 WHERE id=$10`,
      [name, rfc || null, business_name || null, email || null, phone || null,
       address || null, zip_code || null, tax_regime || null, is_active ?? true, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= VENTAS =================
app.post('/api/sales', async (req, res) => {
  const { org_id, warehouse_id, items, payments, user_id, customer_id, discount_amount } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const subtotalVenta = items.reduce(
      (acc, item) => acc + (parseFloat(item.price) * item.quantity), 0
    );
    const totalConIva = Math.max(subtotalVenta * 1.16 - (Number(discount_amount) || 0), 0);

    const saleRes = await client.query(
      `INSERT INTO sales (org_id, warehouse_id, total, discount_amount, created_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
      [org_id || 1, warehouse_id || 1, totalConIva, discount_amount || 0]
    );
    const saleId = saleRes.rows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO sale_details (sale_id, product_id, quantity, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5)`,
        [saleId, item.id, item.quantity, item.price, item.price * item.quantity]
      );

      const invRes = await client.query(
        `SELECT quantity FROM inventory WHERE org_id=$1 AND warehouse_id=$2 AND product_id=$3`,
        [org_id || 1, warehouse_id || 1, item.id]
      );
      const before = parseFloat(invRes.rows[0]?.quantity || 0);
      const after  = before - item.quantity;

      await client.query(
        `INSERT INTO inventory (org_id, warehouse_id, product_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, warehouse_id, product_id)
         DO UPDATE SET quantity = $4, last_update = NOW()`,
        [org_id || 1, warehouse_id || 1, item.id, after]
      );

      await client.query(
        `INSERT INTO inventory_movements
         (org_id, warehouse_id, product_id, movement_type, quantity,
          quantity_before, quantity_after, unit_cost, reference_type, reference_id, user_id)
         VALUES ($1,$2,$3,'venta',$4,$5,$6,$7,'sale',$8,$9)`,
        [org_id || 1, warehouse_id || 1, item.id, item.quantity,
         before, after, item.price, saleId, user_id || null]
      );
    }

    for (const pay of payments) {
      await client.query(
        `INSERT INTO sale_payments (sale_id, payment_method_id, amount) VALUES ($1,$2,$3)`,
        [saleId, pay.payment_method_id, pay.amount]
      );
    }


    if (customer_id) {
      const orgRes = await client.query(`SELECT loyalty_earn_pct FROM organizations WHERE id = $1`, [org_id || 1]);
      const pct = Number(orgRes.rows[0]?.loyalty_earn_pct || 0);
      if (pct > 0) {
        const earned = Number((totalConIva * (pct / 100)).toFixed(2));
        const custRes = await client.query(`SELECT wallet_balance FROM customers WHERE id = $1 FOR UPDATE`, [customer_id]);
        if (custRes.rows.length > 0) {
          const newBalance = Number(custRes.rows[0].wallet_balance) + earned;
          await client.query(`UPDATE customers SET wallet_balance = $1 WHERE id = $2`, [newBalance, customer_id]);
          await client.query(
            `INSERT INTO customer_wallet_movements (customer_id, sale_id, movement_type, amount, balance_after, notes)
             VALUES ($1,$2,'earn',$3,$4,'Compra en tienda')`,
            [customer_id, saleId, earned, newBalance]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, saleId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ================= COMPRAS =================
app.get('/api/purchases', async (req, res) => {
  const { org_id, from, to } = req.query;
  try {
    const result = await pool.query(
      `SELECT pu.*, pr.name AS provider_name, u.name AS user_name
       FROM purchases pu
       LEFT JOIN providers pr ON pr.id = pu.provider_id
       LEFT JOIN users u ON u.id = pu.user_id
       WHERE pu.org_id = $1
         AND ($2::date IS NULL OR pu.purchase_date >= $2::date)
         AND ($3::date IS NULL OR pu.purchase_date <= $3::date + interval '1 day')
       ORDER BY pu.purchase_date DESC`,
      [org_id || 1, from || null, to || null]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/purchases/:id/details', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT pd.*, p.name AS product_name, p.sku
       FROM purchase_details pd
       JOIN products p ON p.id = pd.product_id
       WHERE pd.purchase_id = $1`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/purchases', async (req, res) => {
  const { org_id, warehouse_id, provider_id, purchase_type, folio, notes, items, user_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const total = items.reduce((acc, item) => {
      const totalPieces = (item.pieces || 0) + ((item.boxes || 0) * (item.pieces_per_box || 1));
      const subtotal    = totalPieces * item.unit_cost;
      return acc + (item.has_tax ? subtotal * (1 + (item.tax_rate || 16) / 100) : subtotal);
    }, 0);

    const purchaseRes = await client.query(
      `INSERT INTO purchases (org_id, warehouse_id, provider_id, total, purchase_type, folio, notes, user_id, purchase_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
      [org_id, warehouse_id || 1, provider_id || null, total,
       purchase_type || 'factura', folio || null, notes || null, user_id || null]
    );
    const purchaseId = purchaseRes.rows[0].id;

    for (const item of items) {
      const totalPieces    = (item.pieces || 0) + ((item.boxes || 0) * (item.pieces_per_box || 1));
      const subtotal       = totalPieces * item.unit_cost;
      const subtotalWithTax = item.has_tax ? subtotal * (1 + (item.tax_rate || 16) / 100) : subtotal;

      await client.query(
        `INSERT INTO purchase_details
         (purchase_id, product_id, pieces, boxes, pieces_per_box, total_pieces,
          unit_cost, box_cost, subtotal, tax_rate, has_tax, subtotal_with_tax)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [purchaseId, item.product_id, item.pieces || 0, item.boxes || 0,
         item.pieces_per_box || 1, totalPieces, item.unit_cost,
         item.unit_cost * (item.pieces_per_box || 1),
         subtotal, item.tax_rate || 16, item.has_tax ?? true, subtotalWithTax]
      );

      const invRes = await client.query(
        `SELECT quantity FROM inventory WHERE org_id=$1 AND warehouse_id=$2 AND product_id=$3`,
        [org_id, warehouse_id || 1, item.product_id]
      );
      const before = parseFloat(invRes.rows[0]?.quantity || 0);
      const after  = before + totalPieces;

      await client.query(
        `INSERT INTO inventory (org_id, warehouse_id, product_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, warehouse_id, product_id)
         DO UPDATE SET quantity = $4, last_update = NOW()`,
        [org_id, warehouse_id || 1, item.product_id, after]
      );

      await client.query(
        `INSERT INTO inventory_movements
         (org_id, warehouse_id, product_id, movement_type, quantity,
          quantity_before, quantity_after, unit_cost, reference_type, reference_id, user_id)
         VALUES ($1,$2,$3,'compra',$4,$5,$6,$7,'purchase',$8,$9)`,
        [org_id, warehouse_id || 1, item.product_id, totalPieces,
         before, after, item.unit_cost, purchaseId, user_id || null]
      );

      await client.query(
        `INSERT INTO product_prices
         (sku, product_id, org_id, cost_no_tax, price_no_tax, price_with_tax,
          tax_rate, profit, profit_pct, created_by, notes)
         SELECT p.sku, p.id, $2, $3,
                cp.price_no_tax,
                cp.price_with_tax,
                cp.tax_rate,
                cp.price_no_tax - $3,
                CASE WHEN $3 > 0 THEN ((cp.price_no_tax - $3) / $3) * 100 ELSE 0 END,
                $4,
                'Actualización automática por compra #' || $5
         FROM products p
         LEFT JOIN v_current_prices cp ON cp.sku = p.sku AND cp.org_id = $2
         WHERE p.id = $1`,
        [item.product_id, org_id, item.unit_cost, user_id || null, purchaseId]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, purchaseId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ================= INVENTARIO =================
app.get('/api/inventory', async (req, res) => {
  const { org_id, warehouse_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT i.*, p.name AS product_name, p.sku, p.stock_alert_limit, p.unit_type,
              CASE WHEN i.quantity <= p.stock_alert_limit THEN true ELSE false END AS needs_reorder
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       WHERE i.org_id = $1 AND i.warehouse_id = $2
       ORDER BY p.name`,
      [org_id || 1, warehouse_id || 1]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/inventory/movements', async (req, res) => {
  const { org_id, product_id, warehouse_id, from, to, movement_type } = req.query;

  let conditions = ['im.org_id = $1'];
  let params     = [org_id || 1];
  let i = 2;

  if (product_id)    { conditions.push(`im.product_id = $${i++}`);    params.push(product_id); }
  if (warehouse_id)  { conditions.push(`im.warehouse_id = $${i++}`);  params.push(warehouse_id); }
  if (movement_type) { conditions.push(`im.movement_type = $${i++}`); params.push(movement_type); }
  if (from)          { conditions.push(`im.created_at >= $${i++}`);   params.push(from); }
  if (to)            { conditions.push(`im.created_at <= $${i++}::date + interval '1 day'`); params.push(to); }

  try {
    const result = await pool.query(
      `SELECT
         im.id, im.movement_type, im.quantity, im.quantity_before, im.quantity_after,
         im.unit_cost, im.reference_type, im.reference_id, im.notes, im.created_at,
         p.name AS product_name, p.sku,
         w.name AS warehouse_name,
         u.name AS user_name
       FROM inventory_movements im
       JOIN products p ON p.id = im.product_id
       JOIN warehouses w ON w.id = im.warehouse_id
       LEFT JOIN users u ON u.id = im.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY im.created_at DESC
       LIMIT 500`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ================= CAFETERÍA =================

// Buscar productos de cafetería por nombre
app.get('/api/cafe/products', async (req, res) => {
  const { org_id, q } = req.query;
  try {
    const result = await pool.query(
      `SELECT id, name, description, base_price
       FROM cafe_products
       WHERE org_id = $1 AND is_active = TRUE
         AND ($2::text IS NULL OR name ILIKE $3)
       ORDER BY name`,
      [org_id || 2, q || null, q ? `%${q}%` : null]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener modificadores de un producto de cafetería
app.get('/api/cafe/products/:id/modifiers', async (req, res) => {
  const { id } = req.params;
  try {
    const groups = await pool.query(
      `SELECT mg.id, mg.name, mg.sort_order, mg.required, mg.multiple
       FROM cafe_modifier_groups mg
       JOIN cafe_product_modifiers pm ON pm.group_id = mg.id
       WHERE pm.cafe_product_id = $1 AND mg.is_active = TRUE
       ORDER BY pm.sort_order`,
      [id]
    );

    const result = await Promise.all(
      groups.rows.map(async (group) => {
        const options = await pool.query(
          `SELECT id, name, price_delta, ingredient_product_id,
                  ingredient_qty, ingredient_unit, sort_order
           FROM cafe_modifier_options
           WHERE group_id = $1 AND is_active = TRUE
           ORDER BY sort_order`,
          [group.id]
        );
        return { ...group, options: options.rows };
      })
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar en TODAS las organizaciones (para cobro mixto)
app.get('/api/search/all', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ products: [], cafe: [] });

  try {
    const products = await pool.query(
      `SELECT id, sku, name, price_with_tax AS price, unit_type,
              pieces_per_box, org_id
       FROM v_products_full
       WHERE is_active = TRUE
         AND price_with_tax > 0
         AND (sku ILIKE $1 OR name ILIKE $1)
       ORDER BY name
       LIMIT 10`,
      [`%${q.trim()}%`]
    );

    const cafe = await pool.query(
      `SELECT id, name, base_price AS price, org_id,
              'cafe' AS type
       FROM cafe_products
       WHERE is_active = TRUE
         AND name ILIKE $1
       ORDER BY name
       LIMIT 10`,
      [`%${q.trim()}%`]
    );

    res.json({
      products: products.rows,
      cafe:     cafe.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Registrar venta de cafetería (descuenta ingredientes del inventario)
app.post('/api/cafe/sales', async (req, res) => {
  const { org_id, warehouse_id, items, payments, user_id, customer_id, discount_amount } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const subtotal = items.reduce((acc, item) => acc + (item.final_price * item.quantity), 0);
    const total = Math.max(subtotal - (Number(discount_amount) || 0), 0);

    const saleRes = await client.query(
      `INSERT INTO sales (org_id, warehouse_id, total, discount_amount, created_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
      [org_id || 2, warehouse_id || 1, total, discount_amount || 0]
    );
    const saleId = saleRes.rows[0].id;

    for (const item of items) {
      // Guardar el detalle de qué se vendió (esto faltaba)
      await client.query(
        `INSERT INTO cafe_sale_details
         (sale_id, cafe_product_id, name, quantity, unit_price, subtotal, selected_options, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [saleId, item.cafe_product_id, item.name, item.quantity, item.final_price,
         item.final_price * item.quantity, JSON.stringify(item.selected_options || []), item.notes || null]
      );

      const recipe = await client.query(
        `SELECT ingredient_product_id, quantity, unit FROM cafe_recipes WHERE cafe_product_id = $1`,
        [item.cafe_product_id]
      );

      const modIngredients = (item.selected_options || [])
        .filter(o => o.ingredient_product_id && o.ingredient_qty > 0);

      const ingredientMap = {};
      for (const r of recipe.rows) {
        const key = r.ingredient_product_id;
        const isReplaced = modIngredients.some(m => m.replaces_ingredient_id === key);
        if (!isReplaced) ingredientMap[key] = (ingredientMap[key] || 0) + Number(r.quantity);
      }
      for (const m of modIngredients) {
        const key = m.ingredient_product_id;
        ingredientMap[key] = (ingredientMap[key] || 0) + Number(m.ingredient_qty);
      }

      for (const [productId, qty] of Object.entries(ingredientMap)) {
        const invRes = await client.query(
          `SELECT quantity FROM inventory WHERE org_id=$1 AND warehouse_id=$2 AND product_id=$3`,
          [org_id || 2, warehouse_id || 1, productId]
        );
        const before = parseFloat(invRes.rows[0]?.quantity || 0);
        const after = before - (qty * item.quantity);

        await client.query(
          `INSERT INTO inventory (org_id, warehouse_id, product_id, quantity)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (org_id, warehouse_id, product_id)
           DO UPDATE SET quantity = $4, last_update = NOW()`,
          [org_id || 2, warehouse_id || 1, productId, after]
        );

        await client.query(
          `INSERT INTO inventory_movements
           (org_id, warehouse_id, product_id, movement_type, quantity,
            quantity_before, quantity_after, unit_cost, reference_type, reference_id, user_id)
           VALUES ($1,$2,$3,'venta',$4,$5,$6,0,'sale',$7,$8)`,
          [org_id || 2, warehouse_id || 1, productId, qty * item.quantity, before, after, saleId, user_id || null]
        );
      }
    }

    for (const pay of payments) {
      await client.query(
        `INSERT INTO sale_payments (sale_id, payment_method_id, amount) VALUES ($1,$2,$3)`,
        [saleId, pay.payment_method_id, pay.amount]
      );
    }

    // Monedero — corregido: usa "total" (ya correcto), no la variable NaN de antes
    if (customer_id) {
      const orgRes = await client.query(`SELECT loyalty_earn_pct FROM organizations WHERE id = $1`, [org_id || 2]);
      const pct = Number(orgRes.rows[0]?.loyalty_earn_pct || 0);
      if (pct > 0) {
        const earned = Number((total * (pct / 100)).toFixed(2));
        const custRes = await client.query(`SELECT wallet_balance FROM customers WHERE id = $1 FOR UPDATE`, [customer_id]);
        if (custRes.rows.length > 0) {
          const newBalance = Number(custRes.rows[0].wallet_balance) + earned;
          await client.query(`UPDATE customers SET wallet_balance = $1 WHERE id = $2`, [newBalance, customer_id]);
          await client.query(
            `INSERT INTO customer_wallet_movements (customer_id, sale_id, movement_type, amount, balance_after, notes)
             VALUES ($1,$2,'earn',$3,$4,'Compra en cafetería')`,
            [customer_id, saleId, earned, newBalance]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, saleId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});


// ================= CATÁLOGO CFDI =================
app.get('/api/cfdi-catalog', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT code, description FROM cfdi_usage_catalog WHERE is_active = TRUE ORDER BY code`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= CLIENTES (extendido) =================

// Búsqueda rápida por teléfono o nombre (para el POS)
app.get('/api/customers/search', async (req, res) => {
  const { q, org_id } = req.query;
  if (!q || q.trim().length < 3) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT DISTINCT c.id, c.name, c.email, c.wallet_balance,
              cp.phone AS matched_phone
       FROM customers c
       LEFT JOIN customer_phones cp ON cp.customer_id = c.id
       WHERE c.org_id = $1 AND c.is_active = TRUE
         AND (c.name ILIKE $2 OR cp.phone ILIKE $2)
       ORDER BY c.name
       LIMIT 10`,
      [org_id || 1, `%${q.trim()}%`]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Listado paginado
app.get('/api/customers/paginated', async (req, res) => {
  const { org_id, page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM customers WHERE org_id = $1 AND is_active = TRUE`,
      [org_id || 1]
    );
    const result = await pool.query(
      `SELECT id, name, email, wallet_balance, cfdi_usage
       FROM customers
       WHERE org_id = $1 AND is_active = TRUE
       ORDER BY name
       LIMIT $2 OFFSET $3`,
      [org_id || 1, limit, offset]
    );
    res.json({
      customers: result.rows,
      total: Number(totalRes.rows[0].count),
      page: Number(page),
      totalPages: Math.ceil(Number(totalRes.rows[0].count) / Number(limit)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Detalle completo (teléfonos, direcciones, historial de monedero)
app.get('/api/customers/:id/full', async (req, res) => {
  const { id } = req.params;
  try {
    const customer = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
    if (customer.rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

    const phones = await pool.query(
      `SELECT id, phone, label, is_primary FROM customer_phones WHERE customer_id = $1 ORDER BY is_primary DESC`,
      [id]
    );
    const addresses = await pool.query(
      `SELECT * FROM customer_addresses WHERE customer_id = $1 ORDER BY is_primary DESC`,
      [id]
    );
    const walletHistory = await pool.query(
      `SELECT id, movement_type, amount, balance_after, notes, created_at
       FROM customer_wallet_movements
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [id]
    );

    res.json({
      ...customer.rows[0],
      phones: phones.rows,
      addresses: addresses.rows,
      wallet_history: walletHistory.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crear cliente con teléfonos y direcciones en un solo request
app.post('/api/customers/full', async (req, res) => {
  const { org_id, name, email, cfdi_usage, rfc, business_name, tax_regime, phones, addresses } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const custRes = await client.query(
      `INSERT INTO customers (org_id, name, email, cfdi_usage, rfc, business_name, tax_regime, wallet_balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0) RETURNING id`,
      [org_id || 1, name, email || null, cfdi_usage || null,
       rfc || null, business_name || null, tax_regime || null]
    );
    const customerId = custRes.rows[0].id;

    for (const p of (phones || [])) {
      await client.query(
        `INSERT INTO customer_phones (customer_id, phone, label, is_primary) VALUES ($1,$2,$3,$4)`,
        [customerId, p.phone, p.label || 'Principal', p.is_primary || false]
      );
    }

    for (const a of (addresses || [])) {
      await client.query(
        `INSERT INTO customer_addresses
         (customer_id, label, street, ext_number, int_number, neighborhood, city, state, zip_code, references_text, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [customerId, a.label || 'Casa', a.street || null, a.ext_number || null, a.int_number || null,
         a.neighborhood || null, a.city || null, a.state || null, a.zip_code || null,
         a.references_text || null, a.is_primary || false]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, customerId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Ajuste manual de monedero (opcional, para casos especiales)
app.post('/api/customers/:id/wallet-adjustment', async (req, res) => {
  const { id } = req.params;
  const { amount, notes } = req.body; // amount puede ser negativo
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cust = await client.query(`SELECT wallet_balance FROM customers WHERE id = $1 FOR UPDATE`, [id]);
    if (cust.rows.length === 0) throw new Error('Cliente no encontrado');

    const newBalance = Number(cust.rows[0].wallet_balance) + Number(amount);
    await client.query(`UPDATE customers SET wallet_balance = $1 WHERE id = $2`, [newBalance, id]);
    await client.query(
      `INSERT INTO customer_wallet_movements (customer_id, movement_type, amount, balance_after, notes)
       VALUES ($1,'adjustment',$2,$3,$4)`,
      [id, amount, newBalance, notes || null]
    );

    await client.query('COMMIT');
    res.json({ success: true, newBalance });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Configuración de % de monedero por organización
app.get('/api/organizations/:id/loyalty-settings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, loyalty_earn_pct FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    res.json(result.rows[0] || { loyalty_earn_pct: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/organizations/:id/loyalty-settings', async (req, res) => {
  const { loyalty_earn_pct } = req.body;
  try {
    await pool.query(`UPDATE organizations SET loyalty_earn_pct = $1 WHERE id = $2`, [loyalty_earn_pct, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ================= CORTE DE CAJA =================

// Resumen desde el último corte (o desde siempre si no hay ninguno)
app.get('/api/cash-cuts/summary', async (req, res) => {
  const { warehouse_id } = req.query;
  try {
    // Un solo corte por caja física (warehouse), sin importar si la venta
    // fue de tienda (org 1) o cafetería (org 2) — es el mismo cajón.
    const lastCut = await pool.query(
      `SELECT period_end FROM cash_cuts WHERE warehouse_id = $1 ORDER BY period_end DESC LIMIT 1`,
      [warehouse_id || 1]
    );
    const since = lastCut.rows[0]?.period_end || '1970-01-01';

    const salesRes = await pool.query(
      `SELECT COALESCE(SUM(s.total), 0) AS sales_total, COUNT(*) AS sale_count
       FROM sales s
       WHERE s.warehouse_id = $1 AND s.created_at > $2`,
      [warehouse_id || 1, since]
    );

    const byMethod = await pool.query(
      `SELECT pm.name AS method_name, COALESCE(SUM(sp.amount), 0) AS total
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       JOIN payment_methods pm ON pm.id = sp.payment_method_id
       WHERE s.warehouse_id = $1 AND s.created_at > $2
       GROUP BY pm.name
       ORDER BY pm.name`,
      [warehouse_id || 1, since]
    );

    res.json({
      period_start: since,
      sales_total: Number(salesRes.rows[0].sales_total),
      sale_count: Number(salesRes.rows[0].sale_count),
      by_method: byMethod.rows.map(r => ({ method_name: r.method_name, total: Number(r.total) })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cerrar el corte con el efectivo contado físicamente
app.post('/api/cash-cuts', async (req, res) => {
  const { warehouse_id, user_id, counted_cash, denomination_breakdown, counted_methods } = req.body;
  try {
    const lastCut = await pool.query(
      `SELECT period_end FROM cash_cuts WHERE warehouse_id = $1 ORDER BY period_end DESC LIMIT 1`,
      [warehouse_id || 1]
    );
    const since = lastCut.rows[0]?.period_end || '1970-01-01';

    const salesRes = await pool.query(
      `SELECT COALESCE(SUM(s.total), 0) AS sales_total
       FROM sales s WHERE s.warehouse_id = $1 AND s.created_at > $2`,
      [warehouse_id || 1, since]
    );

    const byMethod = await pool.query(
      `SELECT pm.name AS method_name, COALESCE(SUM(sp.amount), 0) AS total
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       JOIN payment_methods pm ON pm.id = sp.payment_method_id
       WHERE s.warehouse_id = $1 AND s.created_at > $2
       GROUP BY pm.name`,
      [warehouse_id || 1, since]
    );

    // Combina el total esperado por método con lo que el cajero confirmó contar/verificar
    const byMethodFull = byMethod.rows.map((r) => {
      const expected = Number(r.total);
      const match = (counted_methods || []).find((m) => m.method_name === r.method_name);
      const counted = match ? Number(match.counted) : expected;
      return {
        method_name: r.method_name,
        total: expected,
        counted,
        difference: Number((counted - expected).toFixed(2)),
      };
    });

    const cashMethod = byMethodFull.find((r) => r.method_name.toLowerCase().includes('efectivo'));
    const expectedCash = Number(cashMethod?.total || 0);
    const difference = Number((Number(counted_cash) - expectedCash).toFixed(2));

    const result = await pool.query(
      `INSERT INTO cash_cuts
       (org_id, warehouse_id, user_id, period_start, period_end, sales_total,
        payments_breakdown, counted_cash, expected_cash, difference, denomination_breakdown)
       VALUES (NULL,$1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9) RETURNING id`,
      [warehouse_id || 1, user_id || null, since,
       Number(salesRes.rows[0].sales_total),
       JSON.stringify(byMethodFull), counted_cash, expectedCash, difference,
       JSON.stringify(denomination_breakdown || [])]
    );

    res.json({ success: true, cutId: result.rows[0].id, expectedCash, difference, byMethodFull });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Historial de cortes ya realizados
app.get('/api/cash-cuts', async (req, res) => {
  const { warehouse_id, page = 1, limit = 15 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM cash_cuts WHERE warehouse_id = $1`,
      [warehouse_id || 1]
    );
    const result = await pool.query(
      `SELECT cc.id, cc.period_start, cc.period_end, cc.sales_total,
              cc.counted_cash, cc.expected_cash, cc.difference,
              cc.payments_breakdown, u.name AS user_name
       FROM cash_cuts cc
       LEFT JOIN users u ON u.id = cc.user_id
       WHERE cc.warehouse_id = $1
       ORDER BY cc.period_end DESC
       LIMIT $2 OFFSET $3`,
      [warehouse_id || 1, limit, offset]
    );
    res.json({
      cuts: result.rows,
      total: Number(totalRes.rows[0].count),
      page: Number(page),
      totalPages: Math.ceil(Number(totalRes.rows[0].count) / Number(limit)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.put('/api/customers/full/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, cfdi_usage, rfc, business_name, tax_regime, phones, addresses } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE customers SET name=$1, email=$2, cfdi_usage=$3, rfc=$4, business_name=$5, tax_regime=$6 WHERE id=$7`,
      [name, email || null, cfdi_usage || null, rfc || null, business_name || null, tax_regime || null, id]
    );

    // Reemplaza teléfonos y direcciones completos (más simple y confiable que sincronizar uno a uno)
    await client.query(`DELETE FROM customer_phones WHERE customer_id = $1`, [id]);
    for (const p of (phones || [])) {
      await client.query(
        `INSERT INTO customer_phones (customer_id, phone, label, is_primary) VALUES ($1,$2,$3,$4)`,
        [id, p.phone, p.label || 'Principal', p.is_primary || false]
      );
    }

    await client.query(`DELETE FROM customer_addresses WHERE customer_id = $1`, [id]);
    for (const a of (addresses || [])) {
      await client.query(
        `INSERT INTO customer_addresses
         (customer_id, label, street, ext_number, int_number, neighborhood, city, state, zip_code, references_text, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, a.label || 'Casa', a.street || null, a.ext_number || null, a.int_number || null,
         a.neighborhood || null, a.city || null, a.state || null, a.zip_code || null, a.references_text || null, a.is_primary || false]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});


// Ventas detalladas de un corte YA CERRADO (para reimprimir desde el historial)
app.get('/api/cash-cuts/:id/sales', async (req, res) => {
  const { id } = req.params;
  try {
    const cut = await pool.query(`SELECT * FROM cash_cuts WHERE id = $1`, [id]);
    if (cut.rows.length === 0) return res.status(404).json({ error: 'Corte no encontrado' });

    const { warehouse_id, period_start, period_end } = cut.rows[0];

    const sales = await pool.query(
      `SELECT s.id, s.org_id, o.name AS org_name, s.total, s.created_at,
              COALESCE(
                json_agg(json_build_object('method_name', pm.name, 'amount', sp.amount))
                FILTER (WHERE sp.id IS NOT NULL), '[]'
              ) AS payments
       FROM sales s
       JOIN organizations o ON o.id = s.org_id
       LEFT JOIN sale_payments sp ON sp.sale_id = s.id
       LEFT JOIN payment_methods pm ON pm.id = sp.payment_method_id
       WHERE s.warehouse_id = $1 AND s.created_at > $2 AND s.created_at <= $3
       GROUP BY s.id, o.name
       ORDER BY s.created_at ASC`,
      [warehouse_id, period_start, period_end]
    );

    res.json({ cut: cut.rows[0], sales: sales.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ventas del período ACTUAL (aún no se ha cerrado el corte) — para imprimir un preview
app.get('/api/cash-cuts/current-sales', async (req, res) => {
  const { warehouse_id } = req.query;
  try {
    const lastCut = await pool.query(
      `SELECT period_end FROM cash_cuts WHERE warehouse_id = $1 ORDER BY period_end DESC LIMIT 1`,
      [warehouse_id || 1]
    );
    const since = lastCut.rows[0]?.period_end || '1970-01-01';

    const sales = await pool.query(
      `SELECT s.id, s.org_id, o.name AS org_name, s.total, s.created_at,
              COALESCE(
                json_agg(json_build_object('method_name', pm.name, 'amount', sp.amount))
                FILTER (WHERE sp.id IS NOT NULL), '[]'
              ) AS payments
       FROM sales s
       JOIN organizations o ON o.id = s.org_id
       LEFT JOIN sale_payments sp ON sp.sale_id = s.id
       LEFT JOIN payment_methods pm ON pm.id = sp.payment_method_id
       WHERE s.warehouse_id = $1 AND s.created_at > $2
       GROUP BY s.id, o.name
       ORDER BY s.created_at ASC`,
      [warehouse_id || 1, since]
    );

    res.json({ period_start: since, sales: sales.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ================= PRODUCTOS: LISTADO Y EDICIÓN (para el dashboard) =================
 
app.get('/api/products/list', async (req, res) => {
  const { org_id, page = 1, limit = 20, q } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const params = [org_id || 1];
    let searchClause = '';
    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      searchClause = `AND (p.sku ILIKE $${params.length} OR p.name ILIKE $${params.length})`;
    }
 
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM v_products_full p WHERE p.org_id = $1 ${searchClause}`,
      params
    );
 
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT p.id, p.sku, p.name, p.description, p.category, p.unit_type, p.pieces_per_box,
              p.stock_alert_limit, p.price_with_tax, p.price_no_tax, p.cost_no_tax,
              p.is_active
       FROM v_products_full p
       WHERE p.org_id = $1 ${searchClause}
       ORDER BY p.name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
 
    res.json({
      products: result.rows,
      total: Number(totalRes.rows[0].count),
      page: Number(page),
      totalPages: Math.ceil(Number(totalRes.rows[0].count) / Number(limit)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.put('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name, description, category, unit_type, pieces_per_box, stock_alert_limit,
    org_id, cost_no_tax, price_no_tax, price_with_tax, tax_rate, user_id,
  } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
 
    await client.query(
      `UPDATE products SET name=$1, description=$2, category=$3, unit_type=$4,
       pieces_per_box=$5, stock_alert_limit=$6 WHERE id=$7`,
      [name, description || null, category || null, unit_type || 'pieza',
       pieces_per_box || 1, stock_alert_limit || 5, id]
    );
 
    // Si mandan precio nuevo, se agrega una fila nueva en product_prices (historial de precios)
    if ((price_with_tax || price_no_tax) && org_id) {
      const skuRes = await client.query(`SELECT sku FROM products WHERE id = $1`, [id]);
      const sku = skuRes.rows[0]?.sku;
      const priceSinIva = price_no_tax || (price_with_tax / 1.16);
      const precioConIva = price_with_tax || (price_no_tax * 1.16);
      const profit = priceSinIva - (cost_no_tax || 0);
      const profitPct = cost_no_tax > 0 ? (profit / cost_no_tax) * 100 : 0;
 
      await client.query(
        `INSERT INTO product_prices
         (sku, product_id, org_id, cost_no_tax, price_no_tax, price_with_tax, tax_rate, profit, profit_pct, created_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Editado desde dashboard')`,
        [sku, id, org_id, cost_no_tax || 0, priceSinIva, precioConIva, tax_rate || 16, profit, profitPct, user_id || null]
      );
    }
 
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});
 
app.put('/api/products/:id/toggle-active', async (req, res) => {
  const { id } = req.params;
  const { org_id, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE organization_products SET is_active = $1 WHERE product_id = $2 AND org_id = $3`,
      [is_active, id, org_id || 1]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
// ================= CAFETERÍA: CRUD DE PRODUCTOS (para el dashboard) =================
 
app.get('/api/cafe/products/list', async (req, res) => {
  const { org_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT id, name, description, base_price, is_active
       FROM cafe_products WHERE org_id = $1 ORDER BY name`,
      [org_id || 2]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.post('/api/cafe/products', async (req, res) => {
  const { org_id, name, description, base_price } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO cafe_products (org_id, name, description, base_price) VALUES ($1,$2,$3,$4) RETURNING id`,
      [org_id || 2, name, description || null, base_price || 0]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.put('/api/cafe/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, base_price, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE cafe_products SET name=$1, description=$2, base_price=$3, is_active=$4 WHERE id=$5`,
      [name, description || null, base_price || 0, is_active ?? true, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
// ================= CAFETERÍA: CRUD DE GRUPOS DE MODIFICADORES =================
 
app.get('/api/cafe/modifier-groups', async (req, res) => {
  const { org_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT id, name, sort_order, required, multiple, is_active
       FROM cafe_modifier_groups WHERE org_id = $1 ORDER BY sort_order, name`,
      [org_id || 2]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.post('/api/cafe/modifier-groups', async (req, res) => {
  const { org_id, name, sort_order, required, multiple } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO cafe_modifier_groups (org_id, name, sort_order, required, multiple)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [org_id || 2, name, sort_order || 0, required || false, multiple || false]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.put('/api/cafe/modifier-groups/:id', async (req, res) => {
  const { id } = req.params;
  const { name, sort_order, required, multiple, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE cafe_modifier_groups SET name=$1, sort_order=$2, required=$3, multiple=$4, is_active=$5 WHERE id=$6`,
      [name, sort_order || 0, required || false, multiple || false, is_active ?? true, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
// ================= CAFETERÍA: CRUD DE OPCIONES DE MODIFICADORES =================
 
app.get('/api/cafe/modifier-groups/:groupId/options', async (req, res) => {
  const { groupId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, name, price_delta, ingredient_product_id, ingredient_qty, ingredient_unit, sort_order, is_active
       FROM cafe_modifier_options WHERE group_id = $1 ORDER BY sort_order`,
      [groupId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.post('/api/cafe/modifier-options', async (req, res) => {
  const { group_id, name, price_delta, ingredient_product_id, ingredient_qty, ingredient_unit, sort_order } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO cafe_modifier_options
       (group_id, name, price_delta, ingredient_product_id, ingredient_qty, ingredient_unit, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [group_id, name, price_delta || 0, ingredient_product_id || null, ingredient_qty || 0, ingredient_unit || null, sort_order || 0]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.put('/api/cafe/modifier-options/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price_delta, ingredient_product_id, ingredient_qty, ingredient_unit, sort_order, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE cafe_modifier_options
       SET name=$1, price_delta=$2, ingredient_product_id=$3, ingredient_qty=$4, ingredient_unit=$5, sort_order=$6, is_active=$7
       WHERE id=$8`,
      [name, price_delta || 0, ingredient_product_id || null, ingredient_qty || 0, ingredient_unit || null, sort_order || 0, is_active ?? true, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
// ================= CAFETERÍA: LIGAR/DESLIGAR GRUPOS A PRODUCTOS =================
 
app.post('/api/cafe/products/:id/modifier-groups', async (req, res) => {
  const { id } = req.params;
  const { group_id, sort_order } = req.body;
  try {
    await pool.query(
      `INSERT INTO cafe_product_modifiers (cafe_product_id, group_id, sort_order) VALUES ($1,$2,$3)`,
      [id, group_id, sort_order || 0]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.delete('/api/cafe/products/:id/modifier-groups/:groupId', async (req, res) => {
  const { id, groupId } = req.params;
  try {
    await pool.query(
      `DELETE FROM cafe_product_modifiers WHERE cafe_product_id = $1 AND group_id = $2`,
      [id, groupId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
// ================= REPORTES =================
 
// Ventas del día agrupadas (para gráfica de barras / tabla)
app.get('/api/reports/sales-daily', async (req, res) => {
  const { warehouse_id, from, to } = req.query;
  try {
    const result = await pool.query(
      `SELECT DATE(s.created_at) AS day,
              COUNT(*) AS sale_count,
              SUM(s.total) AS total,
              SUM(CASE WHEN s.org_id = 1 THEN s.total ELSE 0 END) AS total_tienda,
              SUM(CASE WHEN s.org_id = 2 THEN s.total ELSE 0 END) AS total_cafe
       FROM sales s
       WHERE s.warehouse_id = $1
         AND ($2::date IS NULL OR s.created_at >= $2::date)
         AND ($3::date IS NULL OR s.created_at < $3::date + interval '1 day')
       GROUP BY DATE(s.created_at)
       ORDER BY day DESC`,
      [warehouse_id || 1, from || null, to || null]
    );
    res.json(result.rows.map(r => ({
      day: r.day,
      sale_count: Number(r.sale_count),
      total: Number(r.total),
      total_tienda: Number(r.total_tienda),
      total_cafe: Number(r.total_cafe),
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
// Ventas "en vivo": últimas N, o de las últimas X horas
app.get('/api/reports/sales-live', async (req, res) => {
  const { warehouse_id, minutes = 240 } = req.query;
  try {
    const result = await pool.query(
      `SELECT s.id, s.org_id, o.name AS org_name, s.total, s.created_at,
              u.name AS cashier_name,
              COALESCE(
                json_agg(json_build_object('method_name', pm.name, 'amount', sp.amount))
                FILTER (WHERE sp.id IS NOT NULL), '[]'
              ) AS payments
       FROM sales s
       JOIN organizations o ON o.id = s.org_id
       LEFT JOIN sale_payments sp ON sp.sale_id = s.id
       LEFT JOIN payment_methods pm ON pm.id = sp.payment_method_id
       LEFT JOIN inventory_movements im ON im.reference_type = 'sale' AND im.reference_id = s.id
       LEFT JOIN users u ON u.id = im.user_id
       WHERE s.warehouse_id = $1
         AND s.created_at > NOW() - ($2 || ' minutes')::interval
       GROUP BY s.id, o.name, u.name
       ORDER BY s.created_at DESC
       LIMIT 100`,
      [warehouse_id || 1, minutes]
    );
    res.json(result.rows.map(r => ({ ...r, total: Number(r.total) })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Productos de cafetería más vendidos en un período
app.get('/api/reports/cafe-top-products', async (req, res) => {
  const { warehouse_id, from, to } = req.query;
  try {
    const result = await pool.query(
      `SELECT csd.cafe_product_id, csd.name,
              SUM(csd.quantity) AS total_qty,
              SUM(csd.subtotal) AS total_revenue,
              COUNT(DISTINCT csd.sale_id) AS times_sold
       FROM cafe_sale_details csd
       JOIN sales s ON s.id = csd.sale_id
       WHERE s.warehouse_id = $1
         AND ($2::date IS NULL OR s.created_at >= $2::date)
         AND ($3::date IS NULL OR s.created_at < $3::date + interval '1 day')
       GROUP BY csd.cafe_product_id, csd.name
       ORDER BY total_qty DESC`,
      [warehouse_id || 1, from || null, to || null]
    );
    res.json(result.rows.map(r => ({
      cafe_product_id: r.cafe_product_id,
      name: r.name,
      total_qty: Number(r.total_qty),
      total_revenue: Number(r.total_revenue),
      times_sold: Number(r.times_sold),
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= PROMOCIONES =================

app.get('/api/promotions', async (req, res) => {
  const { org_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM promotions
       WHERE (org_id = $1 OR org_id IS NULL)
       ORDER BY is_active DESC, created_at DESC`,
      [org_id || 1]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/promotions/:id', async (req, res) => {
  try {
    const promo = await pool.query(`SELECT * FROM promotions WHERE id = $1`, [req.params.id]);
    if (promo.rows.length === 0) return res.status(404).json({ error: 'Promoción no encontrada' });

    const items = await pool.query(
      `SELECT pi.id, pi.product_id, pi.cafe_product_id,
              p.name AS product_name, cp.name AS cafe_product_name
       FROM promotion_items pi
       LEFT JOIN products p ON p.id = pi.product_id
       LEFT JOIN cafe_products cp ON cp.id = pi.cafe_product_id
       WHERE pi.promotion_id = $1`,
      [req.params.id]
    );

    res.json({ ...promo.rows[0], items: items.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/promotions', async (req, res) => {
  const {
    org_id, name, description, type, discount_pct, discount_amount,
    buy_qty, pay_qty, scope, category, start_date, end_date, days_of_week, items,
  } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO promotions
       (org_id, name, description, type, discount_pct, discount_amount, buy_qty, pay_qty,
        scope, category, start_date, end_date, days_of_week)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [org_id || null, name, description || null, type, discount_pct || null, discount_amount || null,
       buy_qty || null, pay_qty || null, scope || 'all', category || null,
       start_date || null, end_date || null, days_of_week || null]
    );
    const promoId = result.rows[0].id;

    for (const item of (items || [])) {
      await client.query(
        `INSERT INTO promotion_items (promotion_id, product_id, cafe_product_id) VALUES ($1,$2,$3)`,
        [promoId, item.product_id || null, item.cafe_product_id || null]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, id: promoId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.put('/api/promotions/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name, description, type, discount_pct, discount_amount, buy_qty, pay_qty,
    scope, category, start_date, end_date, days_of_week, is_active, items,
  } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE promotions SET
       name=$1, description=$2, type=$3, discount_pct=$4, discount_amount=$5,
       buy_qty=$6, pay_qty=$7, scope=$8, category=$9, start_date=$10, end_date=$11,
       days_of_week=$12, is_active=$13
       WHERE id=$14`,
      [name, description || null, type, discount_pct || null, discount_amount || null,
       buy_qty || null, pay_qty || null, scope || 'all', category || null,
       start_date || null, end_date || null, days_of_week || null, is_active ?? true, id]
    );

    if (items) {
      await client.query(`DELETE FROM promotion_items WHERE promotion_id = $1`, [id]);
      for (const item of items) {
        await client.query(
          `INSERT INTO promotion_items (promotion_id, product_id, cafe_product_id) VALUES ($1,$2,$3)`,
          [id, item.product_id || null, item.cafe_product_id || null]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.delete('/api/promotions/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE promotions SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/promotions/evaluate', async (req, res) => {
  const { items } = req.body; // [{ type: 'store'|'cafe', id, quantity, unit_price }]
  try {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=domingo..6=sábado
    const todayStr = today.toISOString().split('T')[0];

    const promosRes = await pool.query(
      `SELECT * FROM promotions
       WHERE is_active = TRUE
         AND (start_date IS NULL OR start_date <= $1)
         AND (end_date IS NULL OR end_date >= $1)
         AND (days_of_week IS NULL OR $2 = ANY(days_of_week))`,
      [todayStr, dayOfWeek]
    );

    const storeIds = items.filter(i => i.type === 'store').map(i => i.id);
    let categoryByProductId = {};
    if (storeIds.length > 0) {
      const catRes = await pool.query(
        `SELECT id, category FROM products WHERE id = ANY($1::int[])`,
        [storeIds]
      );
      categoryByProductId = Object.fromEntries(catRes.rows.map(r => [r.id, r.category]));
    }

    const results = [];

    for (const promo of promosRes.rows) {
      // Determinar qué items del carrito son elegibles para esta promo
      let eligible = [];

      if (promo.scope === 'all') {
        eligible = items.filter(i => {
          if (promo.org_id === null) return true;
          if (promo.org_id === 1) return i.type === 'store';
          if (promo.org_id === 2) return i.type === 'cafe';
          return false;
        });
      } else if (promo.scope === 'category') {
        eligible = items.filter(i => i.type === 'store' && categoryByProductId[i.id] === promo.category);
      } else if (promo.scope === 'products' || promo.scope === 'cafe_products') {
        const itemsRes = await pool.query(
          `SELECT product_id, cafe_product_id FROM promotion_items WHERE promotion_id = $1`,
          [promo.id]
        );
        const productIds = new Set(itemsRes.rows.map(r => r.product_id).filter(Boolean));
        const cafeIds = new Set(itemsRes.rows.map(r => r.cafe_product_id).filter(Boolean));
        eligible = items.filter(i =>
          (i.type === 'store' && productIds.has(i.id)) || (i.type === 'cafe' && cafeIds.has(i.id))
        );
      }

      if (eligible.length === 0) continue;

      const eligibleSubtotal = eligible.reduce((acc, i) => acc + i.unit_price * i.quantity, 0);
      let discount = 0;

      if (promo.type === 'percentage') {
        discount = eligibleSubtotal * (Number(promo.discount_pct) / 100);
      } else if (promo.type === 'fixed_amount') {
        discount = Math.min(Number(promo.discount_amount), eligibleSubtotal);
      } else if (promo.type === 'nxm') {
        // Expandir a precios individuales, ordenar de mayor a menor, agrupar en bloques de buy_qty
        const unitPrices = eligible.flatMap(i => Array(i.quantity).fill(i.unit_price));
        unitPrices.sort((a, b) => b - a);

        const buyQty = promo.buy_qty;
        const payQty = promo.pay_qty;
        const freeCount = buyQty - payQty;

        for (let idx = 0; idx + buyQty <= unitPrices.length; idx += buyQty) {
          const chunk = unitPrices.slice(idx, idx + buyQty);
          const freeItems = chunk.slice(-freeCount); // los más baratos del bloque son gratis
          discount += freeItems.reduce((a, p) => a + p, 0);
        }
      }

      if (discount > 0) {
        results.push({
          promotion_id: promo.id,
          name: promo.name,
          type: promo.type,
          discount: Number(discount.toFixed(2)),
        });
      }
    }

    const totalDiscount = results.reduce((a, r) => a + r.discount, 0);
    res.json({ promotions: results, total_discount: Number(totalDiscount.toFixed(2)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💻 Server corriendo en puerto ${PORT}`));