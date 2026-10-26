// npm run evaluate
// data/eval-pairs.json has 40 objects, each described twice (by the owner who lost it,
// by the person who found it). Every lost description is searched among the 40 found
// items, with keywords and with embeddings, and we check where the right one lands.
// Then it tries different distance thresholds for the match notifications.
// Uses its own database (<DB_NAME>_eval) and writes results/evaluation.md.
const fs = require('fs');
const path = require('path');
const { openDatabase, setupDatabase } = require('./setup-db');
const { embed, itemText, toSql } = require('../src/embeddings');
const { keywordSearch, semanticSearch } = require('../src/search');
const pairs = require('../data/eval-pairs.json');

const THRESHOLDS = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65];

// Puts every lost item and every found item in the database.
// Each lost item has its own owner, so we know who should be notified.
async function insertPairs(db) {
    const category = await db.query(`INSERT INTO categories (name) VALUES ('Other') RETURNING category_id`);
    const categoryId = category.rows[0].category_id;

    async function addUser(email) {
        const result = await db.query(
            `INSERT INTO users (first_name, last_name, email, password_hash)
             VALUES ('Test', 'User', $1, 'not-a-real-hash') RETURNING user_id`, [email]);
        return result.rows[0].user_id;
    }

    async function addItem(kind, { title, description }, userId, date) {
        const vector = toSql(await embed(itemText(title, description)));
        const result = await db.query(
            `INSERT INTO items (kind, title, description, category_id, location, event_date, reported_by, embedding)
             VALUES ($1, $2, $3, $4, 'AUI', $5, $6, $7) RETURNING item_id`,
            [kind, title, description, categoryId, date, userId, vector]);
        return result.rows[0].item_id;
    }

    const finderId = await addUser('finder@aui.ma');
    const owners = [];
    const lostIds = [];
    const foundIds = [];
    // lost items first, then found items: inserting a found item fires the matching trigger
    for (let i = 0; i < pairs.length; i++) {
        owners.push(await addUser(`owner${i}@aui.ma`));
        lostIds.push(await addItem('lost', pairs[i].lost, owners[i], '2026-10-01'));
    }
    for (let i = 0; i < pairs.length; i++) {
        foundIds.push(await addItem('found', pairs[i].found, finderId, '2026-10-02'));
    }
    return { owners, lostIds, foundIds };
}

// Searches every lost description among the found items, counts where the right one lands.
async function scoreSearch(db, searchFunction, foundIds) {
    let first = 0;
    let topThree = 0;
    let noResult = 0;
    for (let i = 0; i < pairs.length; i++) {
        const query = itemText(pairs[i].lost.title, pairs[i].lost.description);
        const results = await searchFunction(db, query, { kind: 'found', limit: 3 });
        const position = results.findIndex((item) => item.item_id === foundIds[i]);
        if (position === 0) first++;
        if (position >= 0) topThree++;
        if (results.length === 0) noResult++;
    }
    return { first, topThree, noResult };
}

// For a threshold, which notifications would the trigger send? It does what the
// trigger does: for each found item, the lost items closer than the threshold, at most 5.
function simulateNotifications(distances, threshold, lostIds, foundIds) {
    let sent = 0;
    let correct = 0;
    for (let f = 0; f < foundIds.length; f++) {
        const close = distances
            .filter((d) => d.found_id === foundIds[f] && d.distance < threshold)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 5);
        sent += close.length;
        correct += close.filter((d) => d.lost_id === lostIds[f]).length;
    }
    return { sent, correct };
}

function percent(count, total) {
    return `${count}/${total} (${Math.round((100 * count) / total)}%)`;
}

async function main() {
    const db = await openDatabase(`${process.env.DB_NAME}_eval`);
    await setupDatabase(db);
    console.log('computing embeddings and inserting 80 items...');
    const { owners, lostIds, foundIds } = await insertPairs(db);
    const total = pairs.length;
    const report = [`# Evaluation\n\n${total} lost items, each searched among ${total} found items described in other words.`];

    // 1. Search: is the right found item first, or in the top 3?
    const keyword = await scoreSearch(db, keywordSearch, foundIds);
    const semantic = await scoreSearch(db, semanticSearch, foundIds);
    report.push([
        '## Search\n',
        '| search | right item first | right item in top 3 | no result at all |',
        '|---|---|---|---|',
        `| keyword (full-text search) | ${percent(keyword.first, total)} | ${percent(keyword.topThree, total)} | ${keyword.noResult} |`,
        `| semantic (embeddings) | ${percent(semantic.first, total)} | ${percent(semantic.topThree, total)} | ${semantic.noResult} |`,
    ].join('\n'));

    // 2. Distances between every lost item and every found item
    const { rows: distances } = await db.query(`
        SELECT lost.item_id AS lost_id, found.item_id AS found_id,
               lost.embedding <=> found.embedding AS distance
        FROM items lost JOIN items found ON lost.kind = 'lost' AND found.kind = 'found'`);
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const rightPairs = distances.filter((d) => lostIds.indexOf(d.lost_id) === foundIds.indexOf(d.found_id));
    const wrongPairs = distances.filter((d) => lostIds.indexOf(d.lost_id) !== foundIds.indexOf(d.found_id));
    report.push([
        '## Distances',
        `Median cosine distance between the two descriptions of the same object: ${median(rightPairs.map((d) => d.distance)).toFixed(2)}`,
        `Median cosine distance between descriptions of different objects: ${median(wrongPairs.map((d) => d.distance)).toFixed(2)}`,
    ].join('\n\n'));

    // 3. Match notifications at different thresholds
    const lines = [
        '## Automatic match notifications\n',
        'For each threshold: how many notifications the trigger would send, how many point to the right item (precision), and how many owners hear about their item (recall).\n',
        '| max distance | notifications | right ones (precision) | owners notified (recall) |',
        '|---|---|---|---|',
    ];
    for (const threshold of THRESHOLDS) {
        const { sent, correct } = simulateNotifications(distances, threshold, lostIds, foundIds);
        const precision = sent === 0 ? '-' : `${Math.round((100 * correct) / sent)}%`;
        lines.push(`| ${threshold} | ${sent} | ${correct} (${precision}) | ${percent(correct, total)} |`);
    }

    // What the real trigger sent while the found items were inserted. It should match
    // the row of the table above for the threshold used in db/triggers.sql.
    const { rows: notifications } = await db.query('SELECT user_id, item_id FROM notifications');
    const right = notifications.filter((n) => owners.indexOf(n.user_id) === foundIds.indexOf(n.item_id)).length;
    lines.push(`\nThe real trigger in db/triggers.sql sent ${notifications.length} notifications, ${right} of them right.`);
    report.push(lines.join('\n'));

    const text = report.join('\n\n') + '\n';
    fs.mkdirSync(path.join(__dirname, '..', 'results'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'results', 'evaluation.md'), text);
    console.log('\n' + text);
    await db.end();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
