const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not connected. Please connect Neon/Postgres to this Vercel project.');
  return neon(process.env.DATABASE_URL);
}

async function init(sql) {
  await sql`CREATE TABLE IF NOT EXISTS fm_users (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS fm_users_name_lower_idx ON fm_users (LOWER(name))`;
  await sql`CREATE TABLE IF NOT EXISTS fm_vehicles (
    id BIGSERIAL PRIMARY KEY,
    model TEXT NOT NULL,
    chassis TEXT NOT NULL UNIQUE,
    colour TEXT NOT NULL,
    received_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'IN STOCK',
    out_date DATE,
    added_by BIGINT NOT NULL REFERENCES fm_users(id),
    closed_by BIGINT REFERENCES fm_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS fm_activity (
    id BIGSERIAL PRIMARY KEY,
    vehicle_id BIGINT NOT NULL REFERENCES fm_vehicles(id),
    action TEXT NOT NULL,
    action_date DATE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES fm_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS fm_sessions (
    token TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES fm_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`;
  const admins = await sql`SELECT id FROM fm_users LIMIT 1`;
  if (!admins.length) {
    const hash = await bcrypt.hash('admin123', 10);
    await sql`INSERT INTO fm_users (name,password_hash,role) VALUES ('Admin',${hash},'admin')`;
  }
}

function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}
function setCookie(res, token, maxAge = 60 * 60 * 24 * 7) {
  res.setHeader('Set-Cookie', `fm_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'fm_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
}
async function userFromReq(sql, req) {
  const token = cookie(req, 'fm_token');
  if (!token) return null;
  const rows = await sql`SELECT u.id,u.name,u.role FROM fm_sessions s JOIN fm_users u ON u.id=s.user_id WHERE s.token=${token} AND s.expires_at > NOW()`;
  return rows[0] || null;
}
function json(res, status, data) {
  res.status(status).setHeader('Content-Type','application/json').send(JSON.stringify(data));
}
function todayIndia() {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}

module.exports = async (req, res) => {
  try {
    const sql = db();
    await init(sql);
    const path = new URL(req.url, 'https://family-motors.local').pathname.replace(/^\/api\/?/, '').replace(/\/$/,'');
    const method = req.method;
    const body = req.body || {};
    const me = await userFromReq(sql, req);

    if (path === 'login' && method === 'POST') {
      const name = String(body.name || '').trim();
      const password = String(body.password || '');
      const rows = await sql`SELECT * FROM fm_users WHERE LOWER(name)=LOWER(${name}) LIMIT 1`;
      const u = rows[0];
      if (!u || !(await bcrypt.compare(password, u.password_hash))) return json(res,401,{error:'Invalid name or password'});
      const token = crypto.randomBytes(32).toString('hex');
      await sql`INSERT INTO fm_sessions(token,user_id,expires_at) VALUES(${token},${u.id},NOW()+INTERVAL '7 days')`;
      setCookie(res, token);
      return json(res,200,{id:u.id,name:u.name,role:u.role});
    }
    if (path === 'logout' && method === 'POST') {
      const token = cookie(req,'fm_token');
      if (token) await sql`DELETE FROM fm_sessions WHERE token=${token}`;
      clearCookie(res);
      return json(res,200,{ok:true});
    }
    if (path === 'me' && method === 'GET') {
      if (!me) return json(res,401,{error:'Not logged in'});
      return json(res,200,me);
    }
    if (!me) return json(res,401,{error:'Not logged in'});

    if (path === 'dashboard' && method === 'GET') {
      const day = todayIndia();
      const [a,b,c,models] = await Promise.all([
        sql`SELECT COUNT(*)::int AS c FROM fm_vehicles WHERE status='IN STOCK'`,
        sql`SELECT COUNT(*)::int AS c FROM fm_vehicles WHERE received_date=${day}`,
        sql`SELECT COUNT(*)::int AS c FROM fm_vehicles WHERE out_date=${day}`,
        sql`SELECT model,COUNT(*)::int AS count FROM fm_vehicles WHERE status='IN STOCK' GROUP BY model ORDER BY count DESC,model`
      ]);
      return json(res,200,{total:a[0].c,ins:b[0].c,outs:c[0].c,models});
    }

    if (path === 'vehicles' && method === 'GET') {
      const q = String(new URL(req.url,'https://family-motors.local').searchParams.get('q') || '').trim();
      const rows = q
        ? await sql`SELECT v.*,u.name AS added_by_name,co.name AS closed_by_name FROM fm_vehicles v JOIN fm_users u ON u.id=v.added_by LEFT JOIN fm_users co ON co.id=v.closed_by WHERE v.chassis ILIKE ${'%'+q+'%'} OR v.model ILIKE ${'%'+q+'%'} OR v.colour ILIKE ${'%'+q+'%'} ORDER BY v.id DESC`
        : await sql`SELECT v.*,u.name AS added_by_name,co.name AS closed_by_name FROM fm_vehicles v JOIN fm_users u ON u.id=v.added_by LEFT JOIN fm_users co ON co.id=v.closed_by ORDER BY v.id DESC`;
      return json(res,200,rows);
    }
    if (path === 'vehicles/in' && method === 'POST') {
      const model=String(body.model||'').trim(), chassis=String(body.chassis||'').trim(), colour=String(body.colour||'').trim(), date=String(body.date||'').trim();
      if(!model||!chassis||!colour||!date) return json(res,400,{error:'Model, chassis, colour and date are required'});
      const exists=await sql`SELECT id FROM fm_vehicles WHERE LOWER(chassis)=LOWER(${chassis}) LIMIT 1`;
      if(exists.length) return json(res,409,{error:'That chassis number already exists'});
      const rows=await sql`INSERT INTO fm_vehicles(model,chassis,colour,received_date,status,added_by) VALUES(${model},${chassis},${colour},${date},'IN STOCK',${me.id}) RETURNING id`;
      await sql`INSERT INTO fm_activity(vehicle_id,action,action_date,user_id) VALUES(${rows[0].id},'IN',${date},${me.id})`;
      return json(res,200,{ok:true,id:rows[0].id});
    }
    const outMatch = path.match(/^vehicles\/(\d+)\/out$/);
    if (outMatch && method === 'POST') {
      const id=Number(outMatch[1]), date=String(body.date||todayIndia());
      const rows=await sql`SELECT * FROM fm_vehicles WHERE id=${id} LIMIT 1`;
      const v=rows[0];
      if(!v) return json(res,404,{error:'Vehicle not found'});
      if(v.status!=='IN STOCK') return json(res,400,{error:'Vehicle is already out'});
      await sql`UPDATE fm_vehicles SET status='OUT',out_date=${date},closed_by=${me.id} WHERE id=${id}`;
      await sql`INSERT INTO fm_activity(vehicle_id,action,action_date,user_id) VALUES(${id},'OUT',${date},${me.id})`;
      return json(res,200,{ok:true});
    }
    if (path === 'history' && method === 'GET') {
      const rows=await sql`SELECT a.*,v.model,v.chassis,v.colour,u.name AS user_name FROM fm_activity a JOIN fm_vehicles v ON v.id=a.vehicle_id JOIN fm_users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 500`;
      return json(res,200,rows);
    }
    if (path === 'users' && method === 'GET') {
      if(me.role!=='admin') return json(res,403,{error:'Admin only'});
      const rows=await sql`SELECT id,name,role,created_at FROM fm_users ORDER BY id`;
      return json(res,200,rows);
    }
    if (path === 'users' && method === 'POST') {
      if(me.role!=='admin') return json(res,403,{error:'Admin only'});
      const name=String(body.name||'').trim(), password=String(body.password||''), role=body.role==='admin'?'admin':'staff';
      if(!name||!password) return json(res,400,{error:'Name and password required'});
      const hash=await bcrypt.hash(password,10);
      try { const rows=await sql`INSERT INTO fm_users(name,password_hash,role) VALUES(${name},${hash},${role}) RETURNING id`; return json(res,200,{ok:true,id:rows[0].id}); }
      catch(e){ return json(res,409,{error:'User name already exists'}); }
    }
    const delMatch=path.match(/^users\/(\d+)$/);
    if(delMatch && method==='DELETE'){
      if(me.role!=='admin') return json(res,403,{error:'Admin only'});
      const id=Number(delMatch[1]); if(id===Number(me.id)) return json(res,400,{error:'You cannot delete your own account'});
      await sql`DELETE FROM fm_users WHERE id=${id}`; return json(res,200,{ok:true});
    }
    return json(res,404,{error:'Not found'});
  } catch (e) {
    console.error(e);
    return json(res,500,{error:e.message || 'Server error'});
  }
};
