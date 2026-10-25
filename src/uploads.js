// Photo uploads (multer). The files go in uploads/, the database only stores the path.
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        // random name so two files called image.jpg don't overwrite each other
        filename: (req, file, done) => {
            const extension = path.extname(file.originalname).toLowerCase();
            done(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${extension}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },  // 5 MB
    // images only, otherwise an uploaded .html file would be served as a page
    fileFilter: (req, file, done) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (!IMAGE_EXTENSIONS.includes(extension)) {
            const error = new Error('The photo must be a .jpg, .png, .webp or .gif image.');
            error.status = 400;
            return done(error);
        }
        done(null, true);
    },
});

module.exports = { upload, UPLOAD_DIR };
