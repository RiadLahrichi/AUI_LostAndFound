// Code shared by every page: calling the API, the menu at the top, and showing items.

// Calls the API and returns the JSON answer. If the server answers with an
// error, this throws it, so pages can show the message with try/catch.
async function api(path, options = {}) {
    const response = await fetch('/api' + path, options);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Something went wrong.');
    }
    return data;
}

// Same, for sending JSON (POST or PATCH)
function sendJson(path, body, method = 'POST') {
    return api(path, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// Text typed by users is shown with this, so that something like
// <script>...</script> in a title is displayed as text and never runs.
function escapeHtml(text) {
    const element = document.createElement('div');
    element.textContent = text == null ? '' : String(text);
    return element.innerHTML;
}

function showMessage(element, text, isError = false) {
    element.textContent = text;
    element.className = 'message ' + (isError ? 'error' : 'success');
}

// Fills a <select> with the categories. Subcategories show as "Electronics / Phones".
async function loadCategories(select, firstOption) {
    const categories = await api('/categories');
    select.innerHTML = `<option value="">${firstOption}</option>` + categories
        .map((c) => `<option value="${c.category_id}">${escapeHtml(c.parent ? c.parent + ' / ' + c.name : c.name)}</option>`)
        .join('');
}

// One item as a card that links to its page. Semantic search results also have a
// similarity between 0 and 1, shown as a percentage.
function itemCard(item) {
    const photo = item.photo
        ? `<img src="${escapeHtml(item.photo)}" alt="">`
        : '<div class="no-photo">No photo</div>';
    const score = item.similarity !== undefined
        ? `<span class="badge score">${Math.round(item.similarity * 100)}% similar</span>`
        : '';
    return `
        <a class="card" href="item.html?id=${item.item_id}">
            ${photo}
            <div class="details">
                <span class="badge ${item.kind}">${item.kind}</span> ${score}
                <h3>${escapeHtml(item.title)}</h3>
                <p class="small-text">${escapeHtml(item.location)}, ${escapeHtml(item.event_date)}</p>
                <p class="small-text">${escapeHtml(item.category)}</p>
            </div>
        </a>`;
}

function showItems(container, items, emptyText) {
    container.innerHTML = items.length > 0
        ? items.map(itemCard).join('')
        : `<p class="empty">${emptyText}</p>`;
}

// The menu changes when you are logged in. Returns the user, or null.
async function showMenu() {
    const { user } = await api('/me');
    let links = `
        <a class="brand" href="index.html">AUI Lost and Found</a>
        <a href="search.html">Search</a>
        <a href="post-item.html">Report an item</a>
        <a href="about.html">About</a>`;
    if (user) {
        const unread = user.unread > 0 ? ` (${user.unread})` : '';
        links += `
            <a href="account.html">My account${unread}</a>
            <button id="logout">Log out</button>`;
    } else {
        links += `
            <a href="login.html">Log in</a>
            <a href="signup.html">Sign up</a>`;
    }
    document.querySelector('.navbar').innerHTML = links;

    if (user) {
        document.getElementById('logout').addEventListener('click', async () => {
            await sendJson('/logout', {});
            window.location.href = 'index.html';
        });
    }
    return user;
}
