// ==========================================
// Nombre Pendiente - Main Application
// ==========================================

// --- Constants ---
const PEER_PREFIX = 'plbattle-';
const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
];
const NOEMBED_URL = 'https://noembed.com/embed';

// --- State ---
const state = {
    userId: null,
    username: '',
    isHost: false,
    roomName: '',
    peer: null,
    connections: [],   // host: connections to guests
    hostConn: null,    // guest: connection to host
    room: {
        phase: 'adding',
        videos: [],
        users: [],
    },
    searchResults: [],
    searching: false,
    connecting: false,
    view: 'home',      // 'home', 'room', 'loading'
};

// --- Initialization ---
function init() {
    state.userId = localStorage.getItem('pb-userid');
    if (!state.userId) {
        state.userId = 'u_' + Math.random().toString(36).substring(2, 11);
        localStorage.setItem('pb-userid', state.userId);
    }
    state.username = localStorage.getItem('pb-username') || '';

    setupEventListeners();
    checkRoute();
    window.addEventListener('hashchange', checkRoute);
}

function checkRoute() {
    const hash = window.location.hash;
    if (hash.startsWith('#/room/')) {
        const roomName = decodeURIComponent(hash.substring(7));
        if (roomName && roomName !== state.roomName) {
            if (!state.username) {
                state.pendingRoom = roomName;
                render();
                return;
            }
            joinRoom(roomName);
        }
    } else {
        if (state.peer) {
            state.peer.destroy();
            state.peer = null;
        }
        state.view = 'home';
        state.roomName = '';
        state.isHost = false;
        state.connections = [];
        state.hostConn = null;
        state.room = { phase: 'adding', videos: [], users: [] };
        state.searchResults = [];
        render();
    }
}

// --- Event Listeners (Delegation) ---
function setupEventListeners() {
    document.addEventListener('submit', (e) => {
        e.preventDefault();
        const form = e.target;

        if (form.id === 'username-form') {
            const input = form.querySelector('input');
            const name = input.value.trim();
            if (!name) return;
            state.username = name;
            localStorage.setItem('pb-username', name);
            if (state.pendingRoom) {
                const room = state.pendingRoom;
                state.pendingRoom = null;
                joinRoom(room);
            } else {
                render();
            }
        }

        if (form.id === 'create-form') {
            const input = form.querySelector('input');
            const name = input.value.trim();
            if (!name) return;
            if (!state.username) {
                state.pendingRoom = null;
                state.pendingCreate = name;
                render();
                return;
            }
            createRoom(name);
        }

        if (form.id === 'join-form') {
            const input = form.querySelector('input');
            const name = input.value.trim();
            if (!name) return;
            window.location.hash = '#/room/' + encodeURIComponent(name);
        }

        if (form.id === 'video-form') {
            const input = form.querySelector('input');
            const query = input.value.trim();
            if (!query) return;
            handleVideoInput(query);
        }
    });

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;

        const action = btn.dataset.action;

        switch (action) {
            case 'copy-url':
                copyShareUrl();
                break;
            case 'add-result':
                addSearchResult(parseInt(btn.dataset.index));
                break;
            case 'vote':
                voteForVideo(btn.dataset.videoId);
                break;
            case 'next-phase':
                nextPhase();
                break;
            case 'play-again':
                playAgain();
                break;
            case 'remove-video':
                removeVideo(btn.dataset.videoId);
                break;
            case 'go-home':
                window.location.hash = '';
                break;
            case 'clear-search':
                state.searchResults = [];
                render();
                break;
        }
    });

    window.addEventListener('beforeunload', (e) => {
        if (state.isHost && state.connections.length > 0) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

// --- PeerJS: Create Room ---
function createRoom(roomName) {
    const sanitized = sanitizeRoomName(roomName);
    if (!sanitized) {
        showToast('Nombre de sala no valido', 'error');
        return;
    }

    state.view = 'loading';
    state.connecting = true;
    state.roomName = roomName;
    render();

    const peerId = PEER_PREFIX + sanitized;
    const peer = new Peer(peerId);

    peer.on('open', () => {
        state.peer = peer;
        state.isHost = true;
        state.connecting = false;
        state.room = {
            phase: 'adding',
            videos: [],
            users: [{ id: state.userId, name: state.username }],
        };
        window.location.hash = '#/room/' + encodeURIComponent(roomName);
        state.view = 'room';
        render();
        showToast('Sala creada', 'success');
    });

    peer.on('connection', (conn) => {
        handleNewConnection(conn);
    });

    peer.on('error', (err) => {
        state.connecting = false;
        if (err.type === 'unavailable-id') {
            showToast('Esa sala ya existe. Intenta unirte o usa otro nombre.', 'error');
            state.view = 'home';
        } else {
            showToast('Error al crear la sala: ' + err.type, 'error');
            state.view = 'home';
        }
        render();
    });

    peer.on('disconnected', () => {
        if (state.isHost) {
            peer.reconnect();
        }
    });
}

// --- PeerJS: Join Room ---
function joinRoom(roomName) {
    const sanitized = sanitizeRoomName(roomName);
    if (!sanitized) {
        showToast('Nombre de sala no valido', 'error');
        return;
    }

    state.view = 'loading';
    state.connecting = true;
    state.roomName = roomName;
    render();

    const peer = new Peer();

    peer.on('open', () => {
        state.peer = peer;
        const hostId = PEER_PREFIX + sanitized;
        const conn = peer.connect(hostId, { reliable: true });

        conn.on('open', () => {
            state.hostConn = conn;
            state.isHost = false;
            state.connecting = false;
            state.view = 'room';
            conn.send({ type: 'join', userId: state.userId, username: state.username });
            render();
        });

        conn.on('data', (data) => {
            handleHostMessage(data);
        });

        conn.on('close', () => {
            state.hostConn = null;
            showToast('Se perdio la conexion con la sala', 'error');
            state.view = 'home';
            state.roomName = '';
            window.location.hash = '';
            render();
        });

        conn.on('error', (err) => {
            showToast('Error de conexion: ' + err, 'error');
        });
    });

    peer.on('error', (err) => {
        state.connecting = false;
        if (err.type === 'peer-unavailable') {
            showToast('La sala no existe o el host se desconecto', 'error');
        } else {
            showToast('Error al conectar: ' + err.type, 'error');
        }
        state.view = 'home';
        state.roomName = '';
        window.location.hash = '';
        render();
    });
}

// --- PeerJS: Host handles new guest connection ---
function handleNewConnection(conn) {
    conn.on('open', () => {
        state.connections.push(conn);
        conn.send({ type: 'state', room: state.room });
    });

    conn.on('data', (data) => {
        handleGuestAction(conn, data);
    });

    conn.on('close', () => {
        state.connections = state.connections.filter(c => c !== conn);
        // Remove user associated with this connection
        if (conn._userId) {
            state.room.users = state.room.users.filter(u => u.id !== conn._userId);
            broadcastState();
            render();
        }
    });
}

// --- PeerJS: Host processes guest actions ---
function handleGuestAction(conn, data) {
    switch (data.type) {
        case 'join': {
            conn._userId = data.userId;
            const exists = state.room.users.find(u => u.id === data.userId);
            if (!exists) {
                state.room.users.push({ id: data.userId, name: data.username });
            } else {
                exists.name = data.username;
            }
            showToast(data.username + ' se unio a la sala', 'success');
            break;
        }
        case 'add-video': {
            if (state.room.phase !== 'adding') return;
            const dup = state.room.videos.find(v => v.id === data.video.id);
            if (dup) {
                conn.send({ type: 'error', message: 'Ese video ya esta en la playlist' });
                return;
            }
            state.room.videos.push(data.video);
            break;
        }
        case 'vote': {
            if (state.room.phase !== 'voting') return;
            // Remove previous vote from this user
            state.room.videos.forEach(v => {
                v.votes = v.votes.filter(uid => uid !== data.userId);
            });
            // Add vote if not un-voting
            const video = state.room.videos.find(v => v.id === data.videoId);
            if (video && !data.unvote) {
                video.votes.push(data.userId);
            }
            break;
        }
    }
    broadcastState();
    render();
}

// --- PeerJS: Guest processes host messages ---
function handleHostMessage(data) {
    switch (data.type) {
        case 'state':
            state.room = data.room;
            render();
            break;
        case 'error':
            showToast(data.message, 'error');
            break;
    }
}

// --- PeerJS: Host broadcasts state to all guests ---
function broadcastState() {
    const msg = { type: 'state', room: state.room };
    state.connections.forEach(conn => {
        if (conn.open) conn.send(msg);
    });
}

// --- YouTube: Extract video ID ---
function extractVideoId(input) {
    const patterns = [
        /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    ];
    for (const pattern of patterns) {
        const match = input.match(pattern);
        if (match) return match[1];
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) return input.trim();
    return null;
}

// --- YouTube: Fetch video info from URL ---
async function fetchVideoInfo(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    try {
        const resp = await fetch(`${NOEMBED_URL}?url=${encodeURIComponent(url)}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        return {
            id: videoId,
            title: data.title || videoId,
            thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
            author: data.author_name || '',
        };
    } catch {
        return {
            id: videoId,
            title: 'Video ' + videoId,
            thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
            author: '',
        };
    }
}

// --- YouTube: Search videos via Piped API ---
async function searchVideos(query) {
    for (const instance of PIPED_INSTANCES) {
        try {
            const resp = await fetch(`${instance}/search?q=${encodeURIComponent(query)}&filter=videos`);
            if (!resp.ok) continue;
            const data = await resp.json();
            const items = data.items || data;
            return items
                .filter(item => item.url || item.videoId)
                .slice(0, 6)
                .map(item => {
                    const videoId = item.videoId || item.url?.replace('/watch?v=', '') || '';
                    return {
                        id: videoId,
                        title: item.title || '',
                        thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                        author: item.uploaderName || item.author || '',
                        duration: item.duration || 0,
                    };
                });
        } catch {
            continue;
        }
    }
    return null;
}

// --- Actions ---
async function handleVideoInput(query) {
    const videoId = extractVideoId(query);
    if (videoId) {
        // It's a YouTube URL/ID - add directly
        const dup = state.room.videos.find(v => v.id === videoId);
        if (dup) {
            showToast('Ese video ya esta en la playlist', 'error');
            return;
        }
        showToast('Agregando video...', 'success');
        const info = await fetchVideoInfo(videoId);
        addVideoToRoom({
            ...info,
            addedBy: state.username,
            votes: [],
        });
        const input = document.querySelector('#video-form input');
        if (input) input.value = '';
    } else {
        // It's a search query
        state.searching = true;
        state.searchResults = [];
        render();
        const results = await searchVideos(query);
        state.searching = false;
        if (results && results.length > 0) {
            state.searchResults = results;
        } else {
            state.searchResults = [];
            showToast('No se encontraron resultados. Podes pegar un link de YouTube directamente.', 'error');
        }
        render();
    }
}

function addVideoToRoom(video) {
    if (state.isHost) {
        const dup = state.room.videos.find(v => v.id === video.id);
        if (dup) {
            showToast('Ese video ya esta en la playlist', 'error');
            return;
        }
        state.room.videos.push(video);
        broadcastState();
        render();
    } else if (state.hostConn) {
        state.hostConn.send({ type: 'add-video', video });
    }
}

function addSearchResult(index) {
    const result = state.searchResults[index];
    if (!result) return;
    addVideoToRoom({
        id: result.id,
        title: result.title,
        thumbnail: result.thumbnail,
        author: result.author,
        addedBy: state.username,
        votes: [],
    });
    state.searchResults = [];
    const input = document.querySelector('#video-form input');
    if (input) input.value = '';
    render();
    showToast('Video agregado', 'success');
}

function voteForVideo(videoId) {
    if (state.room.phase !== 'voting') return;

    if (state.isHost) {
        const currentVote = state.room.videos.find(v =>
            v.votes.includes(state.userId)
        );
        const isUnvote = currentVote && currentVote.id === videoId;

        state.room.videos.forEach(v => {
            v.votes = v.votes.filter(uid => uid !== state.userId);
        });

        if (!isUnvote) {
            const video = state.room.videos.find(v => v.id === videoId);
            if (video) video.votes.push(state.userId);
        }
        broadcastState();
        render();
    } else if (state.hostConn) {
        const currentVote = state.room.videos.find(v =>
            v.votes.includes(state.userId)
        );
        const isUnvote = currentVote && currentVote.id === videoId;
        state.hostConn.send({
            type: 'vote',
            videoId,
            userId: state.userId,
            unvote: isUnvote,
        });
    }
}

function removeVideo(videoId) {
    if (!state.isHost) return;
    state.room.videos = state.room.videos.filter(v => v.id !== videoId);
    broadcastState();
    render();
}

function nextPhase() {
    if (!state.isHost) return;
    if (state.room.phase === 'adding') {
        if (state.room.videos.length === 0) {
            showToast('Agrega al menos un video antes de votar', 'error');
            return;
        }
        state.room.phase = 'voting';
    } else if (state.room.phase === 'voting') {
        state.room.phase = 'results';
    }
    broadcastState();
    render();
}

function playAgain() {
    if (!state.isHost) return;
    state.room.phase = 'adding';
    state.room.videos = [];
    broadcastState();
    render();
}

// --- Rendering ---
function render() {
    const app = document.getElementById('app');

    // Show username modal if needed
    if (!state.username) {
        app.innerHTML = renderUsernameModal();
        const input = app.querySelector('input');
        if (input) input.focus();
        return;
    }

    // Show creating username for pending actions
    if (state.pendingCreate) {
        const name = state.pendingCreate;
        state.pendingCreate = null;
        createRoom(name);
        return;
    }

    switch (state.view) {
        case 'loading':
            app.innerHTML = renderLoading();
            break;
        case 'room':
            app.innerHTML = renderRoom();
            break;
        default:
            app.innerHTML = renderHome();
            break;
    }
}

function renderUsernameModal() {
    return `
        <div class="modal-overlay">
            <div class="modal fade-in">
                <h2>Nombre Pendiente</h2>
                <p>Elegi un nombre para jugar</p>
                <form id="username-form" class="form-group">
                    <input type="text" placeholder="Tu nombre" maxlength="20" required>
                    <button type="submit" class="btn btn-primary">Entrar</button>
                </form>
            </div>
        </div>
    `;
}

function renderHome() {
    return `
        <div class="container fade-in">
            <header class="hero">
                <h1>Nombre Pendiente</h1>
                <p class="subtitle">Crea una sala, agrega videos de YouTube y vota por tu favorito</p>
            </header>
            <div class="home-grid">
                <div class="card">
                    <h2>Crear Sala</h2>
                    <p>Crea una sala nueva y compartila con tus amigos</p>
                    <form id="create-form" class="form-group">
                        <input type="text" placeholder="Nombre de la sala" required maxlength="30">
                        <button type="submit" class="btn btn-primary">Crear Sala</button>
                    </form>
                </div>
                <div class="card">
                    <h2>Unirse</h2>
                    <p>Ingresa el nombre de una sala para unirte</p>
                    <form id="join-form" class="form-group">
                        <input type="text" placeholder="Nombre de la sala" required maxlength="30">
                        <button type="submit" class="btn btn-secondary">Unirse</button>
                    </form>
                </div>
            </div>
            <div style="text-align:center; margin-top:24px;">
                <span class="badge badge-you">Jugando como: ${escapeHtml(state.username)}</span>
            </div>
        </div>
    `;
}

function renderLoading() {
    return `
        <div class="container">
            <div class="loading-view fade-in">
                <div class="spinner"></div>
                <p>Conectando a la sala...</p>
            </div>
        </div>
    `;
}

function renderRoom() {
    const { phase, videos, users } = state.room;
    const phaseLabels = {
        adding: 'Agregando videos',
        voting: 'Votacion',
        results: 'Resultados',
    };

    let content = '';
    switch (phase) {
        case 'adding':
            content = renderAddingPhase();
            break;
        case 'voting':
            content = renderVotingPhase();
            break;
        case 'results':
            content = renderResultsPhase();
            break;
    }

    const shareUrl = window.location.origin + window.location.pathname + '#/room/' + encodeURIComponent(state.roomName);

    const userTags = users.map(u =>
        `<span class="user-tag ${u.id === state.userId ? 'you' : ''}">${escapeHtml(u.name)}${u.id === state.userId ? ' (vos)' : ''}</span>`
    ).join('');

    return `
        <div class="container fade-in">
            <div class="room-header">
                <h1>${escapeHtml(state.roomName)}</h1>
                <div class="share-row">
                    <input type="text" value="${escapeHtml(shareUrl)}" readonly id="share-url">
                    <button class="btn btn-small btn-secondary" data-action="copy-url">Copiar</button>
                </div>
                <div class="room-meta">
                    <span class="badge badge-phase">${phaseLabels[phase]}</span>
                    <span class="badge badge-users">${users.length} jugador${users.length !== 1 ? 'es' : ''}</span>
                    ${state.isHost ? '<span class="badge badge-you">Host</span>' : ''}
                </div>
                ${users.length > 0 ? `<div class="users-list" style="margin-top:12px">${userTags}</div>` : ''}
            </div>
            ${content}
            <div style="text-align:center; padding-top:16px;">
                <button class="btn btn-small btn-secondary" data-action="go-home">Salir de la sala</button>
            </div>
        </div>
    `;
}

function renderAddingPhase() {
    const { videos } = state.room;

    const searchResultsHtml = state.searching
        ? '<div class="empty-state"><div class="spinner"></div><p>Buscando...</p></div>'
        : state.searchResults.length > 0
            ? `
                <div class="search-results">
                    <div class="section-header">
                        <h2>Resultados</h2>
                        <button class="btn btn-small btn-secondary" data-action="clear-search">Cerrar</button>
                    </div>
                    ${state.searchResults.map((r, i) => `
                        <div class="search-result-item" data-action="add-result" data-index="${i}">
                            <img src="${escapeHtml(r.thumbnail)}" alt="">
                            <div class="search-result-info">
                                <h4>${escapeHtml(r.title)}</h4>
                                <span>${escapeHtml(r.author)}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `
            : '';

    const videosHtml = videos.length === 0
        ? '<div class="empty-state"><p>No hay videos todavia. Busca o pega un link para agregar.</p></div>'
        : `<div class="video-grid">${videos.map(v => renderVideoCard(v, 'adding')).join('')}</div>`;

    return `
        <div class="section">
            <form id="video-form" class="search-form">
                <input type="text" placeholder="Buscar video o pegar link de YouTube" required>
                <button type="submit" class="btn btn-primary">${state.searching ? 'Buscando...' : 'Agregar'}</button>
            </form>
            ${searchResultsHtml}
        </div>
        <div class="section">
            <div class="section-header">
                <h2>Playlist (${videos.length})</h2>
            </div>
            ${videosHtml}
        </div>
        ${state.isHost ? `
            <div class="host-controls">
                <button class="btn btn-accent" data-action="next-phase">Comenzar Votacion</button>
            </div>
        ` : ''}
    `;
}

function renderVotingPhase() {
    const { videos } = state.room;

    const videosHtml = videos.length === 0
        ? '<div class="empty-state"><p>No hay videos para votar.</p></div>'
        : `<div class="video-grid">${videos.map(v => renderVideoCard(v, 'voting')).join('')}</div>`;

    return `
        <div class="section">
            <div class="section-header">
                <h2>Vota por tu favorito</h2>
            </div>
            ${videosHtml}
        </div>
        ${state.isHost ? `
            <div class="host-controls">
                <button class="btn btn-accent" data-action="next-phase">Ver Resultados</button>
            </div>
        ` : ''}
    `;
}

function renderResultsPhase() {
    const { videos } = state.room;
    const sorted = [...videos].sort((a, b) => b.votes.length - a.votes.length);

    if (sorted.length === 0) {
        return '<div class="empty-state"><p>No hay resultados.</p></div>';
    }

    const maxVotes = sorted[0].votes.length;
    const winners = sorted.filter(v => v.votes.length === maxVotes && maxVotes > 0);
    const winner = winners[0];

    const winnerHtml = winner ? `
        <div class="winner-section">
            <div class="winner-label">Ganador${winners.length > 1 ? 'es' : ''}</div>
            <div class="winner-card">
                <div class="video-embed">
                    <iframe
                        src="https://www.youtube.com/embed/${escapeHtml(winner.id)}?autoplay=1"
                        allow="autoplay; encrypted-media"
                        allowfullscreen>
                    </iframe>
                </div>
                <div class="winner-info">
                    <h3>${escapeHtml(winner.title)}</h3>
                    <div class="winner-votes">${winner.votes.length} voto${winner.votes.length !== 1 ? 's' : ''}</div>
                </div>
            </div>
        </div>
    ` : `
        <div class="winner-section">
            <div class="winner-label">Sin votos</div>
            <p style="color:var(--text-secondary)">Nadie voto.</p>
        </div>
    `;

    const restHtml = sorted.length > 1 ? `
        <div class="section">
            <div class="section-header">
                <h2>Ranking completo</h2>
            </div>
            <div class="results-list">
                ${sorted.map((v, i) => {
                    const isWinner = v.votes.length === maxVotes && maxVotes > 0;
                    return `
                        <div class="result-item">
                            <div class="result-rank ${isWinner ? 'gold' : ''}">${i + 1}</div>
                            <img src="${escapeHtml(v.thumbnail)}" alt="">
                            <div class="result-info">
                                <h4>${escapeHtml(v.title)}</h4>
                                <span>Agregado por ${escapeHtml(v.addedBy)}</span>
                            </div>
                            <div class="result-votes">${v.votes.length} voto${v.votes.length !== 1 ? 's' : ''}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    ` : '';

    return `
        ${winnerHtml}
        ${restHtml}
        ${state.isHost ? `
            <div class="host-controls">
                <button class="btn btn-accent" data-action="play-again">Jugar de Nuevo</button>
            </div>
        ` : ''}
    `;
}

function renderVideoCard(video, phase) {
    const hasVoted = video.votes.includes(state.userId);

    const voteSection = phase === 'voting' ? `
        <div class="vote-section">
            <button class="vote-btn ${hasVoted ? 'voted' : ''}" data-action="vote" data-video-id="${escapeHtml(video.id)}">
                ${hasVoted ? '&#9829;' : '&#9825;'} Votar
            </button>
            <span class="vote-count">${video.votes.length} voto${video.votes.length !== 1 ? 's' : ''}</span>
        </div>
    ` : '';

    const removeBtn = (phase === 'adding' && state.isHost) ? `
        <button class="btn btn-small btn-icon" data-action="remove-video" data-video-id="${escapeHtml(video.id)}"
                style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.7);border:none;color:var(--error);font-size:1rem;"
                title="Eliminar">&times;</button>
    ` : '';

    return `
        <div class="video-card">
            <div class="thumb-container">
                <img src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(video.title)}" loading="lazy">
                ${removeBtn}
            </div>
            <div class="video-info">
                <div class="video-title">${escapeHtml(video.title)}</div>
                <div class="video-author">${escapeHtml(video.addedBy)}</div>
            </div>
            ${voteSection}
        </div>
    `;
}

// --- Helpers ---
function sanitizeRoomName(name) {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function copyShareUrl() {
    const input = document.getElementById('share-url');
    if (!input) return;
    navigator.clipboard.writeText(input.value).then(() => {
        showToast('Link copiado', 'success');
    }).catch(() => {
        input.select();
        document.execCommand('copy');
        showToast('Link copiado', 'success');
    });
}

let toastTimeout = null;
function showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast visible' + (type ? ' toast-' + type : '');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('visible');
    }, 3000);
}

// --- Start ---
init();
