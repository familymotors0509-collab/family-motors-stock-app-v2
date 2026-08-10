const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ error: 'DATABASE_URL is not connected' });
    }

    const sql = neon(process.env.DATABASE_URL);

    const rows = await sql`
      SELECT *
      FROM fm_vehicles
      ORDER BY id DESC
    `;

    return res.status(200).json(rows);

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || 'Server error'
    });
  }
};
