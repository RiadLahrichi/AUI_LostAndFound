// Creates the tables, views and triggers.
//
//   npm run db:setup
//
// Warning: it deletes the existing tables first, so all data is lost.
const fs = require('fs');
const path = require('path');
const { pool, connect } = require('../src/db');

async function setupDatabase(db) {
    for (const file of ['schema.sql', 'triggers.sql']) {
        const sql = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
        await db.query(sql);
        console.log(`ran db/${file}`);
    }
}

// The evaluation and the tests use their own database, so they never touch the
// app's data. This creates it the first time and returns a pool connected to it.
async function openDatabase(name) {
    const admin = connect('postgres');  // the default database that always exists
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount === 0) {
        // a database name can't be a query parameter, so it is written into the SQL directly
        await admin.query(`CREATE DATABASE "${name}"`);
    }
    await admin.end();
    return connect(name);
}

if (require.main === module) {
    setupDatabase(pool)
        .catch((error) => {
            console.error('Database setup failed:', error.message);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = { setupDatabase, openDatabase };
