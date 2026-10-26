// Found in AUI web server: serves the pages in public/ and the API under /api.
//
//   npm start
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const session = require('express-session');
const { loadModel } = require('./embeddings');
const { UPLOAD_DIR } = require('./uploads');

const app = express();

app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // httpOnly: page scripts can't read the cookie. sameSite: other websites can't use it.
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/items'));
app.use('/api', require('./routes/claims'));
app.use('/api', require('./routes/notifications'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// Every error thrown in a route ends up here. Errors coming from the database
// rules get a clear message, anything else is a real bug and gets logged.
app.use((error, req, res, next) => {
    if (error.code === '23505' && error.constraint === 'one_active_claim_per_item') {
        return res.status(409).json({ error: 'Someone already claimed this item. The finder has to answer that claim first.' });
    }
    if (error.code === '23505' && error.constraint === 'users_email_key') {
        return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    if (error.code === 'P0001') {
        // RAISE EXCEPTION in a trigger: the message is meant for the user
        return res.status(400).json({ error: error.message });
    }
    if (error.code === '23503') {
        // foreign key: the item, category or user does not exist
        return res.status(400).json({ error: 'That item or category does not exist.' });
    }
    if (error.code === '22P02') {
        // text where the database expected a number, like /api/claims/abc
        return res.status(400).json({ error: 'Invalid id.' });
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'The photo is too big (5 MB maximum).' });
    }
    if (error.status && error.status < 500) {
        return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

const port = process.env.PORT || 3000;

// Load the embedding model before accepting requests, so the first search isn't slow.
// The first time, this downloads the model (about 25 MB).
console.log('Loading the embedding model...');
loadModel()
    .then(() => {
        app.listen(port, () => console.log(`Found in AUI is running on http://localhost:${port}`));
    })
    .catch((error) => {
        console.error('Could not load the embedding model. The first start needs internet to download it.');
        console.error(error.message);
        process.exitCode = 1;
    });
