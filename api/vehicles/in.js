const { neon } = require('@neondatabase/serverless');

function json(res, status, data) {
  res
    .status(status)
    .setHeader('Content-Type', 'application/json')
    .send(JSON.stringify(data));
}

function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const part = raw
    .split(';')
    .map(x => x.trim())
    .find(x => x.startsWith(name + '='));

  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method not allowed' });
    }

    if (!process.env.DATABASE_URL) {
      return json(res, 500, { error: 'DATABASE_URL is not connected' });
    }

    const sql = neon(process.env.DATABASE_URL);

    // Check login session
    const token = cookie(req, 'fm_token');

    if (!token) {
      return json(res, 401, { error: 'Not logged in' });
    }

    const users = await sql`
      SELECT u.id, u.name, u.role
      FROM fm_sessions s
      JOIN fm_users u ON u.id = s.user_id
      WHERE s.token = ${token}
        AND s.expires_at > NOW()
      LIMIT 1
    `;

    const me = users[0];

    if (!me) {
      return json(res, 401, { error: 'Not logged in' });
    }

    const body = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : (req.body || {});

    const model = String(body.model || '').trim();
    const chassis = String(body.chassis || '').trim();
    const colour = String(body.colour || '').trim();
    const date = String(body.date || '').trim();

    if (!model || !chassis || !colour || !date) {
      return json(res, 400, {
        error: 'Model, chassis, colour and date are required'
      });
    }

    // Check duplicate chassis number
    const exists = await sql`
      SELECT id
      FROM fm_vehicles
      WHERE LOWER(chassis) = LOWER(${chassis})
      LIMIT 1
    `;

    if (exists.length) {
      return json(res, 409, {
        error: 'That chassis number already exists'
      });
    }

    // Add vehicle to stock
    const rows = await sql`
      INSERT INTO fm_vehicles
        (model, chassis, colour, received_date, status, added_by)
      VALUES
        (${model}, ${chassis}, ${colour}, ${date}, 'IN STOCK', ${me.id})
      RETURNING id
    `;

    // Add activity record
    await sql`
      INSERT INTO fm_activity
        (vehicle_id, action, action_date, user_id)
      VALUES
        (${rows[0].id}, 'IN', ${date}, ${me.id})
    `;

    return json(res, 200, {
      ok: true,
      id: rows[0].id
    });

  } catch (e) {
    console.error(e);

    return json(res, 500, {
      error: e.message || 'Server error'
    });
  }
};
