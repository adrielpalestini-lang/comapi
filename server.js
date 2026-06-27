require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'llave_secreta_pos_2024';

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

// ================= AUTH (LOGIN) =================


// ================= HEALTH CHECK =================
app.get('/api/health', async (req, res) => {
  try {
    const db = await pool.query(`
      SELECT 
        current_database() AS database,
        COUNT(*) AS total_products
      FROM products
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


app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });

    const user = result.rows[0];
    if (password !== user.password_hash) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const token = jwt.sign(
      { id: user.id, org_id: user.org_id, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, org_id: user.org_id }
    });
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
       LEFT JOIN providers pp 
         ON pp.id = prvp.provider_id
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
  const { sku, name, description, category, unit_type, pieces_per_box, stock_alert_limit, org_id, cost_no_tax, price_no_tax, price_with_tax, tax_rate, user_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insertar producto base
    const prodRes = await client.query(
      `INSERT INTO products (sku, name, description, category, unit_type, pieces_per_box, stock_alert_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [sku, name, description || null, category || null, unit_type || 'pieza', pieces_per_box || 1, stock_alert_limit || 5]
    );
    const productId = prodRes.rows[0].id;

    // Asociar a la organización
    await client.query(
      `INSERT INTO organization_products (org_id, product_id) VALUES ($1,$2)`,
      [org_id, productId]
    );

    // Registrar precio inicial si viene
    if (price_with_tax || price_no_tax) {
      const priceSinIva = price_no_tax || (price_with_tax / 1.16);
      const precioConIva = price_with_tax || (price_no_tax * 1.16);
      const profit = priceSinIva - (cost_no_tax || 0);
      const profitPct = cost_no_tax > 0 ? (profit / cost_no_tax) * 100 : 0;

      await client.query(
        `INSERT INTO product_prices (product_id, org_id, cost_no_tax, price_no_tax, price_with_tax, tax_rate, profit, profit_pct, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [productId, org_id, cost_no_tax || 0, priceSinIva, precioConIva, tax_rate || 16, profit, profitPct, user_id || null]
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
      [org_id, name, contact_phone || null, email || null, address || null, rfc || null, business_name || null, zip_code || null, tax_regime || null]
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
      `UPDATE providers SET name=$1, contact_phone=$2, email=$3, address=$4, rfc=$5, business_name=$6, zip_code=$7, tax_regime=$8
       WHERE id=$9`,
      [name, contact_phone || null, email || null, address || null, rfc || null, business_name || null, zip_code || null, tax_regime || null, id]
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
      [org_id, name, rfc || null, business_name || null, email || null, phone || null, address || null, zip_code || null, tax_regime || null]
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
      `UPDATE customers SET name=$1, rfc=$2, business_name=$3, email=$4, phone=$5, address=$6, zip_code=$7, tax_regime=$8, is_active=$9
       WHERE id=$10`,
      [name, rfc || null, business_name || null, email || null, phone || null, address || null, zip_code || null, tax_regime || null, is_active ?? true, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= VENTAS =================

app.post('/api/sales', async (req, res) => {
  const { org_id, warehouse_id, items, payments, user_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const subtotalVenta = items.reduce((acc, item) => acc + (parseFloat(item.price) * item.quantity), 0);
    const totalConIva = subtotalVenta * 1.16;

    const saleRes = await client.query(
      `INSERT INTO sales (org_id, warehouse_id, total, created_at)
       VALUES ($1,$2,$3,NOW()) RETURNING id`,
      [org_id || 1, warehouse_id || 1, totalConIva]
    );
    const saleId = saleRes.rows[0].id;

    for (const item of items) {
      // Detalle de venta
      await client.query(
        `INSERT INTO sale_details (sale_id, product_id, quantity, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5)`,
        [saleId, item.id, item.quantity, item.price, item.price * item.quantity]
      );

      // Saldo actual de inventario
      const invRes = await client.query(
        `SELECT quantity FROM inventory WHERE org_id=$1 AND warehouse_id=$2 AND product_id=$3`,
        [org_id || 1, warehouse_id || 1, item.id]
      );
      const before = parseFloat(invRes.rows[0]?.quantity || 0);
      const after = before - item.quantity;

      // Actualizar inventario
      await client.query(
        `INSERT INTO inventory (org_id, warehouse_id, product_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, warehouse_id, product_id)
         DO UPDATE SET quantity = $4, last_update = NOW()`,
        [org_id || 1, warehouse_id || 1, item.id, after]
      );

      // Registrar movimiento
      await client.query(
        `INSERT INTO inventory_movements
         (org_id, warehouse_id, product_id, movement_type, quantity, quantity_before, quantity_after, unit_cost, reference_type, reference_id, user_id)
         VALUES ($1,$2,$3,'venta',$4,$5,$6,$7,'sale',$8,$9)`,
        [org_id || 1, warehouse_id || 1, item.id, item.quantity, before, after, item.price, saleId, user_id || null]
      );
    }

    // Pagos
    for (const pay of payments) {
      await client.query(
        `INSERT INTO sale_payments (sale_id, payment_method_id, amount) VALUES ($1,$2,$3)`,
        [saleId, pay.payment_method_id, pay.amount]
      );
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
      const subtotal = totalPieces * item.unit_cost;
      return acc + (item.has_tax ? subtotal * (1 + (item.tax_rate || 16) / 100) : subtotal);
    }, 0);

    const purchaseRes = await client.query(
      `INSERT INTO purchases (org_id, warehouse_id, provider_id, total, purchase_type, folio, notes, user_id, purchase_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
      [org_id, warehouse_id || 1, provider_id || null, total, purchase_type || 'factura', folio || null, notes || null, user_id || null]
    );
    const purchaseId = purchaseRes.rows[0].id;

    for (const item of items) {
      const totalPieces = (item.pieces || 0) + ((item.boxes || 0) * (item.pieces_per_box || 1));
      const subtotal = totalPieces * item.unit_cost;
      const subtotalWithTax = item.has_tax ? subtotal * (1 + (item.tax_rate || 16) / 100) : subtotal;

      // Detalle de compra
      await client.query(
        `INSERT INTO purchase_details
         (purchase_id, product_id, pieces, boxes, pieces_per_box, total_pieces, unit_cost, box_cost, subtotal, tax_rate, has_tax, subtotal_with_tax)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [purchaseId, item.product_id, item.pieces || 0, item.boxes || 0, item.pieces_per_box || 1,
         totalPieces, item.unit_cost, item.unit_cost * (item.pieces_per_box || 1),
         subtotal, item.tax_rate || 16, item.has_tax ?? true, subtotalWithTax]
      );

      // Saldo actual
      const invRes = await client.query(
        `SELECT quantity FROM inventory WHERE org_id=$1 AND warehouse_id=$2 AND product_id=$3`,
        [org_id, warehouse_id || 1, item.product_id]
      );
      const before = parseFloat(invRes.rows[0]?.quantity || 0);
      const after = before + totalPieces;

      // Actualizar inventario
      await client.query(
        `INSERT INTO inventory (org_id, warehouse_id, product_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, warehouse_id, product_id)
         DO UPDATE SET quantity = $4, last_update = NOW()`,
        [org_id, warehouse_id || 1, item.product_id, after]
      );

      // Registrar movimiento
      await client.query(
        `INSERT INTO inventory_movements
         (org_id, warehouse_id, product_id, movement_type, quantity, quantity_before, quantity_after, unit_cost, reference_type, reference_id, user_id)
         VALUES ($1,$2,$3,'compra',$4,$5,$6,$7,'purchase',$8,$9)`,
        [org_id, warehouse_id || 1, item.product_id, totalPieces, before, after, item.unit_cost, purchaseId, user_id || null]
      );

      // Actualizar costo en product_prices si el costo cambió
      await client.query(
        `INSERT INTO product_prices (product_id, org_id, cost_no_tax, price_no_tax, price_with_tax, tax_rate, profit, profit_pct, created_by, notes)
         SELECT $1, $2, $3,
                price_no_tax,
                price_with_tax,
                tax_rate,
                price_no_tax - $3,
                CASE WHEN $3 > 0 THEN ((price_no_tax - $3) / $3) * 100 ELSE 0 END,
                $4,
                'Actualización automática por compra #' || $5
         FROM v_current_prices
         WHERE product_id = $1 AND org_id = $2`,
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
  let params = [org_id || 1];
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💻 Server corriendo en puerto ${PORT}`));