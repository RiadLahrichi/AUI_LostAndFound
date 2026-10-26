// PostgreSQL connection pool
const { Pool, types } = require('pg');
require('dotenv').config({ quiet: true });

// Keep DATE columns as text ('2026-10-20'). As JS Dates they shifted by a day with the time zone.
const DATE_TYPE_ID = 1082;
types.setTypeParser(DATE_TYPE_ID, (value) => value);

// The evaluation and the tests pass their own database name
function connect(database = process.env.DB_NAME) {
    return new Pool({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: database,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    });
}

const pool = connect();

module.exports = { pool, connect };
