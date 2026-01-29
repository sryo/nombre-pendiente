const PEER_PREFIX = 'plbattle-';
const NOEMBED_URL = 'https://noembed.com/embed';
const disconnectTimeouts = new Map();

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
        topic: '',
    },
    previewVideoId: null,
    showPlayAgainModal: false,
    reconnectAttempts: 0,
    connecting: false,
    pendingRoom: null,
    pendingCreate: null,
    pendingTopic: null,
    view: 'home',      // 'home', 'room', 'loading'
};

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

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js');
    }
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
        state.reconnectAttempts = 0;
        state.room = { phase: 'adding', videos: [], users: [], topic: '' };
        render();
    }
}

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
            const nameInput = form.querySelector('input[name="room-name"]');
            const topicInput = form.querySelector('input[name="room-topic"]');
            const name = nameInput.value.trim();
            if (!name) return;
            const topic = topicInput ? topicInput.value.trim() : '';
            if (!state.username) {
                state.pendingRoom = null;
                state.pendingCreate = name;
                state.pendingTopic = topic;
                render();
                return;
            }
            createRoom(name, topic);
        }

        if (form.id === 'join-form') {
            const input = form.querySelector('input');
            const name = input.value.trim();
            if (!name) return;
            window.location.hash = '#/room/' + encodeURIComponent(name);
        }

        if (form.id === 'play-again-form') {
            const input = form.querySelector('input[name="play-again-topic"]');
            const topic = input ? input.value.trim() : '';
            confirmPlayAgain(topic);
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
            case 'preview':
                state.previewVideoId = btn.dataset.videoId;
                render();
                break;
            case 'close-preview':
                state.previewVideoId = null;
                render();
                break;
            case 'go-home':
                window.location.hash = '';
                break;
            case 'cancel-play-again':
                cancelPlayAgain();
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

function createRoom(roomName, topic) {
    const sanitized = sanitizeRoomName(roomName);
    if (!sanitized) {
        showToast('Nombre de sala no válido', 'error');
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
            topic: topic || '',
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
            showToast('Esa sala ya existe. Intentá unirte o usá otro nombre.', 'error');
            state.view = 'home';
        } else {
            showToast('Error al crear sala: ' + err.type, 'error');
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

function joinRoom(roomName) {
    const sanitized = sanitizeRoomName(roomName);
    if (!sanitized) {
        showToast('Nombre de sala no válido', 'error');
        return;
    }

    if (state.reconnectAttempts === 0) {
        state.view = 'loading';
        state.connecting = true;
    }
    state.roomName = roomName;
    render();

    if (state.peer) {
        state.peer.destroy();
        state.peer = null;
    }

    const peer = new Peer();

    peer.on('open', () => {
        state.peer = peer;
        const hostId = PEER_PREFIX + sanitized;
        const conn = peer.connect(hostId, { reliable: true });

        conn.on('open', () => {
            state.hostConn = conn;
            state.isHost = false;
            state.connecting = false;
            state.reconnectAttempts = 0;
            state.view = 'room';
            conn.send({ type: 'join', userId: state.userId, username: state.username });
            render();
        });

        conn.on('data', (data) => {
            handleHostMessage(data);
        });

        conn.on('close', () => {
            state.hostConn = null;
            if (state.reconnectAttempts < 3) {
                state.reconnectAttempts++;
                showToast(`Reconectando... (intento ${state.reconnectAttempts}/3)`, 'error');
                render();
                const targetRoom = roomName;
                setTimeout(() => {
                    if (state.roomName !== targetRoom) return;
                    joinRoom(roomName);
                }, 2000);
            } else {
                state.reconnectAttempts = 0;
                showToast('Se perdió la conexión con la sala', 'error');
                state.view = 'home';
                state.roomName = '';
                window.location.hash = '';
                render();
            }
        });

        conn.on('error', (err) => {
            if (state.reconnectAttempts === 0) {
                showToast('Error de conexión: ' + err, 'error');
            }
        });
    });

    peer.on('error', (err) => {
        state.connecting = false;
        if (state.reconnectAttempts > 0) return;
        if (err.type === 'peer-unavailable') {
            showToast('La sala no existe o el host se desconectó', 'error');
        } else {
            showToast('Error al conectar: ' + err.type, 'error');
        }
        state.view = 'home';
        state.roomName = '';
        window.location.hash = '';
        render();
    });
}

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
        // Wait 15s for reconnection before removing user
        if (conn._userId) {
            const userId = conn._userId;
            if (disconnectTimeouts.has(userId)) {
                clearTimeout(disconnectTimeouts.get(userId));
            }
            const timeoutId = setTimeout(() => {
                disconnectTimeouts.delete(userId);
                const hasActiveConn = state.connections.some(c => c._userId === userId && c.open);
                if (!hasActiveConn) {
                    state.room.users = state.room.users.filter(u => u.id !== userId);
                    broadcastState();
                    render();
                }
            }, 15000);
            disconnectTimeouts.set(userId, timeoutId);
        }
    });
}

function handleGuestAction(conn, data) {
    switch (data.type) {
        case 'join': {
            conn._userId = data.userId;
            if (disconnectTimeouts.has(data.userId)) {
                clearTimeout(disconnectTimeouts.get(data.userId));
                disconnectTimeouts.delete(data.userId);
            }
            const exists = state.room.users.find(u => u.id === data.userId);
            if (!exists) {
                state.room.users.push({ id: data.userId, name: data.username });
            } else {
                exists.name = data.username;
            }
            showToast(data.username + ' se unió', 'success');
            break;
        }
        case 'add-video': {
            if (state.room.phase !== 'adding') return;
            const alreadyAdded = state.room.videos.find(v => v.addedBy === data.video.addedBy);
            if (alreadyAdded) {
                conn.send({ type: 'error', message: 'Ya agregaste tu video' });
                return;
            }
            const dup = state.room.videos.find(v => v.id === data.video.id);
            if (dup) {
                conn.send({ type: 'error', message: 'Ese video ya está en la playlist' });
                return;
            }
            state.room.videos.push(data.video);
            break;
        }
        case 'vote': {
            if (state.room.phase !== 'voting') return;
            applyVote(data.userId, data.videoId, data.unvote);
            break;
        }
    }
    broadcastState();
    render();
}

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

function broadcastState() {
    const msg = { type: 'state', room: state.room };
    state.connections.forEach(conn => {
        if (conn.open) conn.send(msg);
    });
}

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

async function handleVideoInput(query) {
    const alreadyAdded = state.room.videos.find(v => v.addedBy === state.username);
    if (alreadyAdded) {
        showToast('Ya agregaste tu video', 'error');
        return;
    }
    const videoId = extractVideoId(query);
    if (!videoId) {
        showToast('Pegá un link de YouTube válido', 'error');
        return;
    }
    const dup = state.room.videos.find(v => v.id === videoId);
    if (dup) {
        showToast('Ese video ya está en la playlist', 'error');
        return;
    }
    showToast('Agregando...', 'success');
    const info = await fetchVideoInfo(videoId);
    addVideoToRoom({
        ...info,
        addedBy: state.username,
        votes: [],
    });
    const input = document.querySelector('#video-form input');
    if (input) input.value = '';
}

function addVideoToRoom(video) {
    if (state.isHost) {
        state.room.videos.push(video);
        broadcastState();
        render();
    } else if (state.hostConn) {
        state.hostConn.send({ type: 'add-video', video });
    }
}

function isUnvote(userId, videoId) {
    const current = state.room.videos.find(v => v.votes.includes(userId));
    return current && current.id === videoId;
}

function applyVote(userId, videoId, unvote) {
    state.room.videos.forEach(v => {
        v.votes = v.votes.filter(uid => uid !== userId);
    });
    if (!unvote) {
        const video = state.room.videos.find(v => v.id === videoId);
        if (video) video.votes.push(userId);
    }
}

function voteForVideo(videoId) {
    if (state.room.phase !== 'voting') return;
    const unvoting = isUnvote(state.userId, videoId);

    if (state.isHost) {
        applyVote(state.userId, videoId, unvoting);
        broadcastState();
        render();
    } else if (state.hostConn) {
        state.hostConn.send({
            type: 'vote',
            videoId,
            userId: state.userId,
            unvote: unvoting,
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
            showToast('Agregá al menos un video', 'error');
            return;
        }
        state.room.phase = 'voting';
    } else if (state.room.phase === 'voting') {
        state.room.phase = 'results';
    }
    state.previewVideoId = null;
    broadcastState();
    render();
}

function playAgain() {
    if (!state.isHost) return;
    state.showPlayAgainModal = true;
    render();
}

function confirmPlayAgain(topic) {
    state.showPlayAgainModal = false;
    state.room.phase = 'adding';
    state.room.videos = [];
    state.room.topic = (topic || '').trim();
    broadcastState();
    render();
}

function cancelPlayAgain() {
    state.showPlayAgainModal = false;
    render();
}

function renderPlayAgainModal() {
    if (!state.showPlayAgainModal) return '';
    return `
        <div class="modal-overlay">
            <div class="modal">
                <h2>Jugar de nuevo</h2>
                <p>Elegí la temática para la nueva ronda</p>
                <form id="play-again-form" class="form-group">
                    <input type="text" name="play-again-topic" placeholder="Temática (opcional)" maxlength="60">
                    <button type="submit" class="btn btn-primary">Comenzar</button>
                    <button type="button" class="btn btn-secondary" data-action="cancel-play-again">Cancelar</button>
                </form>
            </div>
        </div>
    `;
}

let lastView = null;
function render() {
    const app = document.getElementById('app');

    // Deferred room creation after username is set
    if (state.username && state.pendingCreate) {
        const name = state.pendingCreate;
        const topic = state.pendingTopic || '';
        state.pendingCreate = null;
        state.pendingTopic = null;
        createRoom(name, topic);
        return;
    }

    const currentView = !state.username ? 'username' : state.view;
    let html;
    if (!state.username) {
        html = renderUsernameModal();
    } else {
        switch (state.view) {
            case 'loading': html = renderLoading(); break;
            case 'room':    html = renderRoom(); break;
            default:        html = renderHome(); break;
        }
    }

    morphdom(app, `<div id="app">${html}</div>`);

    // Fade in only on view transitions
    if (currentView !== lastView) {
        app.firstElementChild?.classList.add('fade-in');
        lastView = currentView;
    }

    if (!state.username) {
        const input = app.querySelector('input');
        if (input && document.activeElement !== input) input.focus();
    }
}

function renderUsernameModal() {
    return `
        <div class="modal-overlay">
            <div class="modal">
                <h2>Nombre Pendiente</h2>
                <p>Elegí tu nombre</p>
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
        <div class="container">
            <header class="hero">
                <h1>Nombre Pendiente</h1>
                <p class="subtitle">Agregá videos, votá y elegí al ganador</p>
            </header>
            <div class="home-grid">
                <div class="card">
                    <h2>Crear sala</h2>
                    <p>Creá una sala y compartila</p>
                    <form id="create-form" class="form-group">
                        <input type="text" name="room-name" placeholder="Nombre de la sala" required maxlength="30">
                        <input type="text" name="room-topic" placeholder="Temática (opcional)" maxlength="60">
                        <button type="submit" class="btn btn-primary">Crear sala</button>
                    </form>
                </div>
                <div class="card">
                    <h2>Unirse</h2>
                    <p>Entrá a la sala de un amigo</p>
                    <form id="join-form" class="form-group">
                        <input type="text" placeholder="Nombre de la sala" required maxlength="30">
                        <button type="submit" class="btn btn-secondary">Entrar</button>
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
            <div class="loading-view">
                <div class="spinner"></div>
                <p>Conectando...</p>
            </div>
        </div>
    `;
}

function renderRoom() {
    const { phase, videos, users } = state.room;
    const phaseLabels = {
        adding: 'Agregando',
        voting: 'Votación',
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

    const votedUserIds = (phase === 'voting' || phase === 'results')
        ? new Set(videos.flatMap(v => v.votes))
        : new Set();

    const userTags = users.map(u => {
        const isYou = u.id === state.userId;
        const hasVoted = votedUserIds.has(u.id);
        const classes = ['user-tag', isYou ? 'you' : '', hasVoted ? 'voted' : ''].filter(Boolean).join(' ');
        const label = escapeHtml(u.name) + (isYou ? ' (vos)' : '') + (hasVoted ? ' ✓' : '');
        return `<span class="${classes}">${label}</span>`;
    }).join('');

    return `
        <div class="container">
            <div class="room-header">
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
            ${state.reconnectAttempts > 0 ? `<div class="reconnect-banner">Reconectando... (intento ${state.reconnectAttempts}/3)</div>` : ''}
            ${state.room.topic ? `<div class="topic-banner">${escapeHtml(state.room.topic)}</div>` : ''}
            ${content}
            <div style="text-align:center; padding-top:16px;">
                <button class="btn btn-small btn-secondary" data-action="go-home">Salir</button>
            </div>
        </div>
        ${renderPreviewModal()}
        ${renderPlayAgainModal()}
    `;
}

function renderAddingPhase() {
    const { videos } = state.room;
    const hasAdded = videos.some(v => v.addedBy === state.username);

    const videosHtml = videos.length === 0
        ? '<div class="empty-state"><p>Pegá un link de YouTube</p></div>'
        : `<div class="video-grid">${videos.map(v => renderVideoCard(v, 'adding')).join('')}</div>`;

    const formHtml = hasAdded
        ? `<div class="added-message">Ya agregaste tu video</div>`
        : `<form id="video-form" class="search-form">
                <input type="text" placeholder="Link de YouTube" required>
                <button type="submit" class="btn btn-primary">Agregar</button>
            </form>`;

    return `
        <div class="section">
            ${formHtml}
        </div>
        <div class="section">
            <div class="section-header">
                <h2>Playlist (${videos.length})</h2>
            </div>
            ${videosHtml}
        </div>
        ${state.isHost ? `
            <div class="host-controls">
                <button class="btn btn-accent" data-action="next-phase">Comenzar votación</button>
            </div>
        ` : ''}
    `;
}

function renderVotingPhase() {
    const { videos } = state.room;

    const videosHtml = videos.length === 0
        ? '<div class="empty-state"><p>No hay videos.</p></div>'
        : `<div class="video-grid">${videos.map(v => renderVideoCard(v, 'voting')).join('')}</div>`;

    return `
        <div class="section">
            <div class="section-header">
                <h2>Votá por tu favorito</h2>
            </div>
            ${videosHtml}
        </div>
        ${state.isHost ? `
            <div class="host-controls">
                <button class="btn btn-accent" data-action="next-phase">Ver resultados</button>
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
            <p style="color:var(--text-secondary)">Nadie votó.</p>
        </div>
    `;

    const restHtml = sorted.length > 1 ? `
        <div class="section">
            <div class="section-header">
                <h2>Ranking</h2>
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
                                <span>${escapeHtml(v.addedBy)}</span>
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
                <button class="btn btn-accent" data-action="play-again">Jugar de nuevo</button>
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
        </div>
    ` : '';

    const removeBtn = (phase === 'adding' && state.isHost) ? `
        <button class="btn btn-small" data-action="remove-video" data-video-id="${escapeHtml(video.id)}"
                style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.7);border:none;color:var(--error);font-size:1rem;"
                title="Eliminar">&times;</button>
    ` : '';

    return `
        <div class="video-card">
            <div class="thumb-container" data-action="preview" data-video-id="${escapeHtml(video.id)}" style="cursor:pointer">
                <img src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(video.title)}" loading="lazy">
                <div class="play-overlay">&#9654;</div>
                ${removeBtn}
            </div>
            <div class="video-info">
                <div class="video-title">${escapeHtml(video.title)}</div>
                <div class="video-author">${state.room.phase === 'results' ? escapeHtml(video.addedBy) : ''}</div>
            </div>
            ${voteSection}
        </div>
    `;
}

function renderPreviewModal() {
    if (!state.previewVideoId) return '';
    return `
        <div class="modal-overlay" data-action="close-preview">
            <div class="preview-modal">
                <button class="preview-close-btn" data-action="close-preview">&times;</button>
                <div class="preview-player" onclick="event.stopPropagation()">
                    <iframe
                        src="https://www.youtube.com/embed/${escapeHtml(state.previewVideoId)}?autoplay=1"
                        allow="autoplay; encrypted-media"
                        allowfullscreen>
                    </iframe>
                </div>
            </div>
        </div>
    `;
}

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

init();
