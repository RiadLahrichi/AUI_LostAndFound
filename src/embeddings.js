// Text to embedding: 384 numbers that describe the meaning of the text.
// "black wireless earbuds" and "AirPods case" end up close together even though
// they share no word. The model (all-MiniLM-L6-v2) runs locally, no API key.
// The first run downloads it, about 25 MB.
const { pipeline } = require('@huggingface/transformers');

let extractor = null;

async function loadModel() {
    if (!extractor) {
        // q8 = smaller quantized version, fast enough on a CPU
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    }
    return extractor;
}

async function embed(text) {
    const model = await loadModel();
    // mean pooling averages the word vectors into one vector for the whole text,
    // normalize makes its length 1
    const output = await model(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

function itemText(title, description) {
    return `${title}. ${description}`;
}

// pgvector reads '[0.12,-0.03,...]', which is what JSON.stringify gives
function toSql(vector) {
    return JSON.stringify(vector);
}

module.exports = { embed, itemText, toSql, loadModel };
