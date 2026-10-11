// =====================================================================
//  admin-module.js  —  Autenticación + Usuarios + Organizaciones
//
//  USO en server.js (ver LEEME-ADMIN.md):
//    const installAdmin = require('./admin-module');
//    ...justo después de  app.use(express.json());  y de crear `pool`:
//    installAdmin(app, { pool, jwt, JWT_SECRET });
//
//  Debe instalarse ANTES de las demás rutas: el middleware tiene que
//  ver las peticiones primero. El login nuevo también queda primero, así
//  que gana al viejo (puedes borrar el viejo `app.post('/api/auth/login'`).
// =====================================================================

const ADMIN_ROLES = ['admin', 'administrador', 'administrator'];
const ALLOWED_ROLES = ['cashier', 'admin'];           // lo que el dashboard permite asignar
const isAdminRole = (r) => ADMIN_ROLES.includes(String(r || '').trim().toLowerCase());

module.exports = function installAdmin(app, { pool, jwt, JWT_SECRET }) {
  if (!process.env.JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET no está definido en el entorno: se usa el valor del código (público en el repo). Defínelo en Azure App Service.');
  }
  // ---------------------------------------------------------------
  // 1) Login (reemplaza al anterior)
  //    - Valida is_active
  //    - Devuelve role y email
  //    - Contraseñas en texto plano (por ahora, a petición)
  // ---------------------------------------------------------------
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    try {
      if (!email || !password) return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
      const r = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [String(email).trim()]);
      if (r.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
      const user = r.rows[0];
      if (user.is_active === false) return res.status(403).json({ error: 'Usuario desactivado' });
      if (String(password) !== user.password_hash) return res.status(401).json({ error: 'Contraseña incorrecta' });

      const token = jwt.sign(
        { id: user.id, org_id: user.org_id, role: user.role },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      res.json({
        token,
        user: { id: user.id, name: user.name, email: user.email, org_id: user.org_id, role: user.role },
      });
    } catch (e) {
      res.status(500).json({ error: 'Error en login' });
    }
  });

  // ---------------------------------------------------------------
  // 2) Middleware de autenticación
  // ---------------------------------------------------------------
  const ENFORCE_ALL = String(process.env.ENFORCE_AUTH_ALL || '').toLowerCase() === 'true';
  const ENFORCE_REPORTS = String(process.env.ENFORCE_REPORTS || 'true').toLowerCase() !== 'false';

  // Públicas: portal de facturación, login, health y listado de organizaciones (lo usa el otro frontend)
  const isPublic = (req) => {
    const p = req.path;
    if (p === '/api/health' || p === '/api/auth/login') return true;
    if (p.startsWith('/api/billing')) return true;
    if (p === '/api/cfdi-usage' || p === '/api/cfdi-catalog') return true;
    if (req.method === 'GET' && p === '/api/organizations') return true;
    return false;
  };

  const seen = new Set();
  const audit = (req, why) => {
    const key = `${req.method} ${req.path.replace(/\/\d+/g, '/:id')}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.warn(`[AUTH-AUDIT] ${why}: ${key}`);
  };

  app.use((req, res, next) => {
    if (req.method === 'OPTIONS' || !req.path.startsWith('/api/')) return next();
    if (isPublic(req)) return next();

    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    let payload = null;
    if (token) {
      try { payload = jwt.verify(token, JWT_SECRET); } catch (_) { payload = null; }
    }
    if (payload) req.user = payload;

    const needsAdmin = req.path.startsWith('/api/admin/') || (ENFORCE_REPORTS && req.path.startsWith('/api/reports/'));
    if (needsAdmin) {
      if (!payload) return res.status(401).json({ error: 'No autenticado' });
      if (!isAdminRole(payload.role)) return res.status(403).json({ error: 'Solo administradores' });
      return next();
    }

    if (!payload) {
      if (ENFORCE_ALL) return res.status(401).json({ error: 'No autenticado' });
      audit(req, 'sin token (permitido por ahora)');
    }
    next();
  });

  const adminOnly = (req, res, next) => {
    // Defensa extra por si el middleware se reordena
    if (!req.user || !isAdminRole(req.user.role)) return res.status(403).json({ error: 'Solo administradores' });
    next();
  };

  // ---------------------------------------------------------------
  // 3) Usuarios
  // ---------------------------------------------------------------
  const userSelect = `
    SELECT u.id, u.org_id, o.name AS org_name, u.name, u.email,
           u.password_hash AS password, u.role, u.is_active, u.created_at
    FROM users u LEFT JOIN organizations o ON o.id = u.org_id`;

  app.get('/api/admin/users', adminOnly, async (req, res) => {
    try {
      const r = await pool.query(`${userSelect} ORDER BY u.is_active DESC, u.role, u.name`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const cleanUserBody = (b, { partial }) => {
    const out = {};
    const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
    if (!partial || b.name !== undefined) {
      const v = String(b.name ?? '').trim();
      if (!v) err('El nombre es obligatorio');
      if (v.length > 100) err('El nombre admite máximo 100 caracteres');
      out.name = v;
    }
    if (!partial || b.email !== undefined) {
      const v = String(b.email ?? '').trim();
      if (!v) err('El correo es obligatorio');
      if (v.length > 100) err('El correo admite máximo 100 caracteres');
      out.email = v;
    }
    if (!partial || b.password !== undefined) {
      const v = String(b.password ?? '');
      if (!v.trim()) err('La contraseña es obligatoria');
      out.password_hash = v;
    }
    if (!partial || b.org_id !== undefined) {
      const v = Number(b.org_id);
      if (!Number.isInteger(v) || v <= 0) err('Selecciona una organización');
      out.org_id = v;
    }
    if (b.role !== undefined || !partial) {
      const v = String(b.role ?? 'cashier').trim();
      out.role = v;
    }
    if (b.is_active !== undefined) out.is_active = !!b.is_active;
    return out;
  };

  const dbError = (e, res) => {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
    if (e.code === '23503') return res.status(400).json({ error: 'La organización seleccionada no existe' });
    if (e.code === '22001') return res.status(400).json({ error: 'Un valor excede la longitud permitida' });
    return res.status(500).json({ error: e.message });
  };

  app.post('/api/admin/users', adminOnly, async (req, res) => {
    try {
      const d = cleanUserBody(req.body || {}, { partial: false });
      if (!ALLOWED_ROLES.includes(d.role)) return res.status(400).json({ error: 'Tipo de usuario inválido (cajero o admin)' });
      const r = await pool.query(
        `INSERT INTO users (org_id, name, email, password_hash, role, is_active)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [d.org_id, d.name, d.email, d.password_hash, d.role, d.is_active ?? true]
      );
      const u = await pool.query(`${userSelect} WHERE u.id = $1`, [r.rows[0].id]);
      res.status(201).json(u.rows[0]);
    } catch (e) { dbError(e, res); }
  });

  app.put('/api/admin/users/:id', adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    try {
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });
      const cur = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
      if (cur.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
      const before = cur.rows[0];
      const d = cleanUserBody(req.body || {}, { partial: true });

      if (d.role !== undefined && d.role !== before.role && !ALLOWED_ROLES.includes(d.role)) {
        return res.status(400).json({ error: 'Tipo de usuario inválido (cajero o admin)' });
      }

      // Protecciones: no quedarte sin administradores ni cortarte la rama en la que estás sentado
      const newRole = d.role !== undefined ? d.role : before.role;
      const newActive = d.is_active !== undefined ? d.is_active : before.is_active;
      const losesAdmin = isAdminRole(before.role) && before.is_active !== false &&
                         (!isAdminRole(newRole) || newActive === false);
      if (losesAdmin) {
        if (req.user.id === id) {
          return res.status(400).json({ error: 'No puedes quitarte tu propio acceso de administrador ni desactivarte' });
        }
        const others = await pool.query(
          `SELECT COUNT(*)::int AS n FROM users
           WHERE id <> $1 AND is_active IS NOT FALSE AND LOWER(role) = ANY($2)`,
          [id, ADMIN_ROLES]
        );
        if (others.rows[0].n === 0) return res.status(400).json({ error: 'Debe quedar al menos un administrador activo' });
      }

      const cols = Object.keys(d);
      if (cols.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
      const sets = cols.map((c, i) => `${c} = $${i + 1}`);
      await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${cols.length + 1}`, [...cols.map((c) => d[c]), id]);
      const u = await pool.query(`${userSelect} WHERE u.id = $1`, [id]);
      res.json(u.rows[0]);
    } catch (e) { dbError(e, res); }
  });
  // No hay DELETE a propósito: ventas, cortes, gastos y movimientos referencian al usuario.
  // Para "borrar" a alguien se desactiva (is_active = false) y ya no puede entrar.

  // ---------------------------------------------------------------
  // 4) Organizaciones (columnas dinámicas desde information_schema)
  // ---------------------------------------------------------------
  const READONLY_COLS = ['id', 'created_at'];
  const NUMERIC = ['integer', 'smallint', 'bigint', 'numeric', 'real', 'double precision'];

  const orgColumns = async () => {
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable, character_maximum_length,
              numeric_precision, numeric_scale, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
       ORDER BY ordinal_position`
    );
    return r.rows.map((c) => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === 'YES',
      max_length: c.character_maximum_length,
      precision: c.numeric_precision,
      scale: c.numeric_scale,
      has_default: c.column_default !== null,
      readonly: READONLY_COLS.includes(c.column_name),
    }));
  };

  const coerceOrg = (body, cols, { partial }) => {
    const out = {};
    for (const col of cols) {
      if (col.readonly) continue;
      if (!(col.name in body)) {
        continue;
      }
      let v = body[col.name];
      const fail = (m) => { const e = new Error(`${col.name}: ${m}`); e.status = 400; throw e; };
      if (v === '' || v === undefined) v = null;
      if (v === null) {
        if (!col.nullable && !col.has_default) fail('es obligatorio');
        if (!col.nullable) continue;      // tiene default: se omite
        out[col.name] = null;
        continue;
      }
      if (NUMERIC.includes(col.type)) {
        const n = Number(v);
        if (!Number.isFinite(n)) fail('debe ser un número');
        out[col.name] = n;
      } else if (col.type === 'boolean') {
        out[col.name] = v === true || v === 'true' || v === 1 || v === '1';
      } else if (col.type === 'json' || col.type === 'jsonb') {
        out[col.name] = typeof v === 'string' ? v : JSON.stringify(v);
      } else {
        v = String(v).trim();
        if (col.max_length && v.length > col.max_length) fail(`máximo ${col.max_length} caracteres`);
        if (v === '' && !col.nullable) fail('es obligatorio');
        out[col.name] = v;
      }
    }
    return out;
  };

  app.get('/api/admin/organizations', adminOnly, async (req, res) => {
    try {
      const [columns, rows] = await Promise.all([
        orgColumns(),
        pool.query('SELECT * FROM organizations ORDER BY id'),
      ]);
      res.json({ columns, rows: rows.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/organizations/:id', adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    try {
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });
      const cols = await orgColumns();
      const d = coerceOrg(req.body || {}, cols, { partial: true });
      const keys = Object.keys(d);
      if (keys.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
      const r = await pool.query(
        `UPDATE organizations SET ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')}
         WHERE id = $${keys.length + 1} RETURNING *`,
        [...keys.map((k) => d[k]), id]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Organización no encontrada' });
      res.json(r.rows[0]);
    } catch (e) { dbError(e, res); }
  });

  app.post('/api/admin/organizations', adminOnly, async (req, res) => {
    try {
      const cols = await orgColumns();
      const d = coerceOrg(req.body || {}, cols, { partial: false });
      // columnas NOT NULL sin default que faltaron
      for (const c of cols) {
        if (!c.readonly && !c.nullable && !c.has_default && d[c.name] === undefined) {
          return res.status(400).json({ error: `${c.name}: es obligatorio` });
        }
      }
      const keys = Object.keys(d);
      const r = keys.length
        ? await pool.query(
            `INSERT INTO organizations (${keys.map((k) => `"${k}"`).join(',')})
             VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
            keys.map((k) => d[k]))
        : await pool.query('INSERT INTO organizations DEFAULT VALUES RETURNING *');
      res.status(201).json(r.rows[0]);
    } catch (e) { dbError(e, res); }
  });
};

module.exports.isAdminRole = isAdminRole;