// Resets the database and fills it with demo data from data/seed.json:
// categories, users, lost and found items, and one claim.
//
//   npm run db:seed
//
// Every demo user has the password "demo1234".
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { embed, itemText, toSql } = require('../src/embeddings');
const { setupDatabase } = require('./setup-db');
const seed = require('../data/seed.json');

const DEMO_PASSWORD = 'demo1234';

async function main() {
    await setupDatabase(pool);

    // Parents are listed before their subcategories in seed.json, so the parent id is known
    const categoryIds = {};
    for (const category of seed.categories) {
        const result = await pool.query(
            'INSERT INTO categories (name, parent_id) VALUES ($1, $2) RETURNING category_id',
            [category.name, categoryIds[category.parent] || null]);
        categoryIds[category.name] = result.rows[0].category_id;
    }

    const userIds = {};
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    for (const user of seed.users) {
        const result = await pool.query(
            `INSERT INTO users (first_name, last_name, email, password_hash, role)
             VALUES ($1, $2, $3, $4, $5) RETURNING user_id`,
            [user.firstName, user.lastName, user.email, passwordHash, user.role || 'student']);
        userIds[user.email] = result.rows[0].user_id;
    }

    // Oldest first, like they would have been posted. The matching trigger runs on every insert.
    // In seed.json, daysAgo says when the item was lost or found: CURRENT_DATE - 3 is three days ago.
    console.log('computing embeddings...');
    const itemIds = {};
    const items = [...seed.items].sort((a, b) => b.daysAgo - a.daysAgo);
    for (const item of items) {
        const vector = toSql(await embed(itemText(item.title, item.description)));
        const result = await pool.query(
            `INSERT INTO items (kind, title, description, category_id, location, event_date, reported_by, embedding)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE - $6::int, $7, $8) RETURNING item_id`,
            [item.kind, item.title, item.description, categoryIds[item.category], item.location,
             item.daysAgo, userIds[item.by], vector]);
        itemIds[item.title] = result.rows[0].item_id;
    }

    for (const claim of seed.claims) {
        await pool.query('INSERT INTO claims (item_id, claimant_id, message) VALUES ($1, $2, $3)',
            [itemIds[claim.item], userIds[claim.by], claim.message]);
    }

    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM notifications');
    console.log(`added ${seed.categories.length} categories, ${seed.users.length} users, ${seed.items.length} items, ` +
        `${seed.claims.length} claim. The triggers created ${rows[0].count} notifications.`);
    console.log(`Demo users all have the password "${DEMO_PASSWORD}", for example ${seed.users[0].email}`);
}

main()
    .catch((error) => {
        console.error('Seeding failed:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
