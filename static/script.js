document.addEventListener('DOMContentLoaded', () => {
    loadData();
    setupNavigation();
});

let appData = {};

async function loadData() {
    try {
        const response = await fetch('static/data.json');
        appData = await response.json();
        
        renderSocials(appData.profile.contact);
        renderProjects(appData.projects);
        renderArticles(appData.articles);
        renderCerts(appData.certifications);
        
    } catch (error) {
        console.error("Data load failed:", error);
    }
}

function setupNavigation() {
    const links = document.querySelectorAll('.nav-link');
    links.forEach(link => {
        link.addEventListener('click', () => {
            // UI State
            links.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            
            // View State
            const targetId = link.getAttribute('data-target');
            document.querySelectorAll('.view-section').forEach(view => {
                view.classList.remove('active');
            });
            document.getElementById(targetId).classList.add('active');
            window.scrollTo(0,0);
        });
    });
}

function renderSocials(contacts) {
    const container = document.querySelector('.social-bar');
    if(container) {
        container.innerHTML = contacts.map(c => `
            <a href="${c.url}" target="_blank" class="social-link" title="${c.platform}">
                <i class="${c.icon}"></i>
            </a>
        `).join('');
    }
}

function renderProjects(projects) {
    const grid = document.getElementById('projects-grid');
    grid.innerHTML = projects.map(p => `
        <div class="card">
            <div class="card-header">
                <div class="card-title">${p.title}</div>
                <i class="fas fa-arrow-right card-icon"></i>
            </div>
            <p class="card-desc">${p.description}</p>
            <div class="tags">
                ${p.tags.map(t => `<span class="tag">${t}</span>`).join('')}
            </div>
            <div style="margin-top: auto;">
                 ${p.links.map(l => `<a href="${l.url}" target="_blank" class="card-link">${l.label}</a>`).join(' <span style="color: var(--border-light); font-size: 0.8rem;">|</span> ')}
            </div>
        </div>
    `).join('');
}

function renderArticles(articles) {
    const grid = document.getElementById('articles-grid');
    grid.innerHTML = articles.map(a => `
        <div class="card">
            <div class="card-header">
                <div class="card-title">${a.title}</div>
            </div>
            <p class="card-desc">${a.description}</p>
            <a href="${a.url}" target="_blank" class="card-link">READ ARTICLE</a>
        </div>
    `).join('');
}

function renderCerts(certs) {
    const grid = document.getElementById('certs-grid');
    grid.innerHTML = certs.map(c => `
        <a href="${c.url}" target="_blank" class="cert-item" title="${c.name}">
            <img src="${c.image}" alt="${c.name}">
        </a>
    `).join('');
}

