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

  return part
    ? decodeURIComponent(part.slice(name.length + 1))
    : null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method not allowed' });
    }

    if (!process.env.DATABASE_URL) {
      return json(res, 500, {
        error: 'DATABASE_URL is not connected'
      });
    }

    const sql = neon(process.env.DATABASE_URL);

    // Check login
    const token = cookie(req, 'fm_token');

    if (!token) {
      return json(res, 401, {
        error: 'Not logged in'
      });
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
      return json(res, 401, {
        error: 'Not logged in'
      });
    }

    const id = Number(req.query.id);

    if (!Number.isInteger(id)) {
      return json(res, 400, {
        error: 'Invalid vehicle ID'
      });
    }

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

    const date = String(body.date || '').trim();

    if (!date) {
      return json(res, 400, {
        error: 'Out date is required'
      });
    }

    // Find vehicle
    const rows = await sql`
      SELECT *
      FROM fm_vehicles
      WHERE id = ${id}
      LIMIT 1
    `;

    const vehicle = rows[0];

    if (!vehicle) {
      return json(res, 404, {
        error: 'Vehicle not found'
      });
    }

    if (vehicle.status !== 'IN STOCK') {
      return json(res, 400, {
        error: 'Vehicle is already out'
      });
    }

    // Move vehicle OUT
    await sql`
      UPDATE fm_vehicles
      SET
        status = 'OUT',
        out_date = ${date},
        closed_by = ${me.id}
      WHERE id = ${id}
    `;

    // Add history record
    await sql`
      INSERT INTO fm_activity
        (vehicle_id, action, action_date, user_id)
      VALUES
        (${id}, 'OUT', ${date}, ${me.id})
    `;

    return json(res, 200, {
      ok: true
    });

  } catch (error) {
    console.error(error);

    return json(res, 500, {
      error: error.message || 'Server error'
    });
  }
};
