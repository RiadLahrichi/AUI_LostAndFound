// npm test
// Tests for the rules in the database (constraints, triggers, functions).
// Runs on its own database (<DB_NAME>_test). No model needed, the vectors are made by hand.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openDatabase, setupDatabase } = require('../scripts/setup-db');

let db;
let categoryId;
const users = {};

// A 384-number vector with the given first numbers and zeros after.
// [1, 0.2] and [1, 0.3] point almost the same way (cosine distance close to 0),
// [1] and [0, 1] point in completely different directions (distance 1).
function vector(...firstNumbers) {
    const values = new Array(384).fill(0);
    firstNumbers.forEach((value, index) => { values[index] = value; });
    return JSON.stringify(values);
}

async function addItem(kind, title, userId, date = '2026-10-01', embedding = null) {
    const { rows } = await db.query(
        `INSERT INTO items (kind, title, description, category_id, location, event_date, reported_by, embedding)
         VALUES ($1, $2, 'test item', $3, 'Library', $4, $5, $6) RETURNING item_id`,
        [kind, title, categoryId, date, userId, embedding]);
    return rows[0].item_id;
}

async function notificationsOf(userId) {
    const { rows } = await db.query('SELECT message FROM notifications WHERE user_id = $1', [userId]);
    return rows.map((row) => row.message);
}

before(async () => {
    db = await openDatabase(`${process.env.DB_NAME}_test`);
    await setupDatabase(db);
    const { rows } = await db.query(`INSERT INTO categories (name) VALUES ('Other') RETURNING category_id`);
    categoryId = rows[0].category_id;
    for (const name of ['owner', 'finder', 'other']) {
        const result = await db.query(
            `INSERT INTO users (first_name, last_name, email, password_hash)
             VALUES ($1, 'Test', $2, 'hash') RETURNING user_id`,
            [name, `${name}@aui.ma`]);
        users[name] = result.rows[0].user_id;
    }
});

after(async () => {
    await db.end();
});

test('only @aui.ma emails can be stored', async () => {
    await assert.rejects(
        db.query(`INSERT INTO users (first_name, last_name, email, password_hash) VALUES ('a', 'b', 'a@gmail.com', 'h')`),
        /users_email_check/);
});

test('an item can go from open to returned, but not back', async () => {
    const itemId = await addItem('lost', 'Umbrella', users.owner);
    await db.query(`UPDATE items SET status = 'returned' WHERE item_id = $1`, [itemId]);
    await assert.rejects(
        db.query(`UPDATE items SET status = 'open' WHERE item_id = $1`, [itemId]),
        /Invalid status change from returned to open/);
});

test('only found items can be claimed, and not by the person who found them', async () => {
    const lostId = await addItem('lost', 'Wallet', users.owner);
    const foundId = await addItem('found', 'Keys', users.finder);
    await assert.rejects(
        db.query('INSERT INTO claims (item_id, claimant_id, message) VALUES ($1, $2, $3)', [lostId, users.other, 'mine']),
        /Only found items can be claimed/);
    await assert.rejects(
        db.query('INSERT INTO claims (item_id, claimant_id, message) VALUES ($1, $2, $3)', [foundId, users.finder, 'mine']),
        /cannot claim an item you posted yourself/);
});

test('an item has only one active claim, a new one is allowed after a rejection', async () => {
    const foundId = await addItem('found', 'Phone', users.finder);
    const first = await db.query(
        'INSERT INTO claims (item_id, claimant_id, message) VALUES ($1, $2, $3) RETURNING claim_id',
        [foundId, users.owner, 'it is mine']);
    await assert.rejects(
        db.query('INSERT INTO claims (item_id, claimant_id, message) VALUES ($1, $2, $3)', [foundId, users.other, 'no, mine']),
        /one_active_claim_per_item/);

    await db.query(`UPDATE claims SET status = 'rejected' WHERE claim_id = $1`, [first.rows[0].claim_id]);
    await db.query('INSERT INTO claims (item_id, claimant_id, message) VALUES ($1, $2, $3)', [foundId, users.other, 'no, mine']);
});

test('a claim notifies the finder, and approving it marks the item claimed', async () => {
    const foundId = await addItem('found', 'Red scarf', users.finder);
    const claim = await db.query(
        'INSERT INTO claims (item_id, claimant_id, message) VALUES ($1, $2, $3) RETURNING claim_id',
        [foundId, users.owner, 'my grandmother made it']);
    assert.ok((await notificationsOf(users.finder)).some((m) => m.includes('Someone claimed "Red scarf"')));

    await db.query(`UPDATE claims SET status = 'approved' WHERE claim_id = $1`, [claim.rows[0].claim_id]);
    const item = await db.query('SELECT status FROM items WHERE item_id = $1', [foundId]);
    assert.strictEqual(item.rows[0].status, 'claimed');
    assert.ok((await notificationsOf(users.owner)).some((m) => m.includes('was approved') && m.includes('finder@aui.ma')));
});

test('a found item close in meaning to a lost item notifies the owner', async () => {
    await addItem('lost', 'Black earbuds', users.other, '2026-10-01', vector(1, 0.2));
    await addItem('found', 'AirPods case', users.finder, '2026-10-02', vector(1, 0.3));    // close: notify
    await addItem('found', 'Textbook', users.finder, '2026-10-02', vector(0, 1));         // far: no notification
    await addItem('found', 'Old earbuds', users.finder, '2026-09-01', vector(1, 0.25));   // found before it was lost

    const messages = await notificationsOf(users.other);
    assert.ok(messages.some((m) => m.includes('"AirPods case"') && m.includes('"Black earbuds"')));
    assert.ok(!messages.some((m) => m.includes('Textbook')));
    assert.ok(!messages.some((m) => m.includes('Old earbuds')));
});

test('category_tree returns a category and all its subcategories', async () => {
    const parent = await db.query(`INSERT INTO categories (name) VALUES ('Electronics') RETURNING category_id`);
    const parentId = parent.rows[0].category_id;
    const child = await db.query(`INSERT INTO categories (name, parent_id) VALUES ('Phones', $1) RETURNING category_id`, [parentId]);
    await db.query(`INSERT INTO categories (name, parent_id) VALUES ('Android phones', $1)`, [child.rows[0].category_id]);

    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM category_tree($1)', [parentId]);
    assert.strictEqual(rows[0].count, 3);
});
