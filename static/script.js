// DOM Elements
const joinContainer       = document.getElementById('join-container');
const callContainer       = document.getElementById('call-container');
const connectionStatus    = document.getElementById('connection-status');
const roomIdDisplay       = document.getElementById('room-id-display');
const roomIdInput         = document.getElementById('room-id-input');
const createRoomBtn       = document.getElementById('create-room-btn');
const joinRoomBtn         = document.getElementById('join-room-btn');
const copyRoomBtn         = document.getElementById('copy-room-btn');
const toggleVideoBtn      = document.getElementById('toggle-video-btn');
const toggleMicBtn        = document.getElementById('toggle-mic-btn');
const leaveBtn            = document.getElementById('leave-btn');
const localVideo          = document.getElementById('local-video');
const remoteVideo         = document.getElementById('remote-video');
const localSignText       = document.getElementById('local-sign-text');
const remoteSignText      = document.getElementById('remote-sign-text');
const startSpeechBtn      = document.getElementById('start-speech-btn');
const speechText          = document.getElementById('speech-text');
const convertBtn          = document.getElementById('convert-btn');
const signImagesContainer = document.getElementById('sign-images-container');
const chatInput           = document.getElementById('chat-input');
const sendChatBtn         = document.getElementById('send-chat-btn');
const chatMessages        = document.getElementById('chat-messages');
const signHistory         = document.getElementById('sign-history');
const clearHistoryBtn     = document.getElementById('clear-history-btn');
const unreadBadge         = document.getElementById('unread-badge');

// WebRTC config
const servers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// State
let socket, localStream, peerConnection, roomId;
let isCameraOn = true, isMicOn = true;
let isConnected = false, isRemoteVideoConnected = false;
let frameInterval, recognition;
let unreadCount = 0;
let historyCount = 0;

// ── Init ──────────────────────────────────────────────
function init() {
    socket = io();
    setupSocketEvents();
    setupUIEvents();
    setupSpeechRecognition();
}

// ── Socket Events ─────────────────────────────────────
function setupSocketEvents() {
    socket.on('connect', () => showToast('Connected to server', 'success'));

    socket.on('disconnect', () => {
        showToast('Disconnected from server', 'error');
        handleDisconnect();
    });

    socket.on('room_created', (data) => handleRoomCreated(data.room_id));

    socket.on('room_joined', (data) => {
        if (data.success) {
            handleRoomJoined(data.room_id);
        } else {
            showToast(`Failed to join: ${data.message}`, 'error');
            hideConnectionStatus();
        }
    });

    socket.on('user_joined', () => {
        showToast('A user joined the room', 'success');
        startCall();
    });

    socket.on('user_left', () => {
        showToast('The other user left the room', 'warning');
        handlePeerDisconnect();
    });

    socket.on('video_frame', (data) => {
        if (!isRemoteVideoConnected) {
            const img = new Image();
            img.onload = () => {
                if (!isRemoteVideoConnected) {
                    remoteVideo.style.backgroundImage = `url(${data.frame})`;
                    remoteVideo.style.backgroundSize = 'cover';
                    remoteVideo.style.backgroundPosition = 'center';
                }
                updateSignText(remoteSignText, data.detected_sign);
            };
            img.src = data.frame;
        } else {
            updateSignText(remoteSignText, data.detected_sign);
        }

        if (data.detected_sign) {
            addToHistory(data.detected_sign, data.confidence, 'remote');
        }
    });

    socket.on('sign_detected', (data) => {
        updateSignText(localSignText, data.sign);
        if (data.sign) addToHistory(data.sign, data.confidence, 'you');
    });

    socket.on('speech_to_sign_result', (data) => displaySpeechToSignResult(data));

    socket.on('chat_message', (data) => {
        appendChatMessage(data.message, 'received', data.time);
        if (document.hidden) {
            unreadCount++;
            unreadBadge.textContent = unreadCount;
            unreadBadge.classList.remove('hidden');
        }
    });
}

// ── UI Events ─────────────────────────────────────────
function setupUIEvents() {
    createRoomBtn.addEventListener('click', createRoom);
    joinRoomBtn.addEventListener('click', joinRoom);
    copyRoomBtn.addEventListener('click', copyRoomId);
    toggleVideoBtn.addEventListener('click', toggleVideo);
    toggleMicBtn.addEventListener('click', toggleMic);
    leaveBtn.addEventListener('click', leaveRoom);
    startSpeechBtn.addEventListener('click', startSpeechRecognition);
    convertBtn.addEventListener('click', convertSpeechToSign);
    sendChatBtn.addEventListener('click', sendChatMessage);
    clearHistoryBtn.addEventListener('click', clearHistory);

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });

    roomIdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinRoom();
    });

    // Clear unread when user focuses chat
    chatMessages.addEventListener('click', () => {
        unreadCount = 0;
        unreadBadge.classList.add('hidden');
    });
}

// ── Room Actions ──────────────────────────────────────
function createRoom() {
    showConnectionStatus();
    socket.emit('create_room');
}

function joinRoom() {
    const id = roomIdInput.value.trim();
    if (id) {
        showConnectionStatus();
        socket.emit('join_room', { room_id: id });
    } else {
        showToast('Please enter a Room ID', 'warning');
    }
}

function handleRoomCreated(newRoomId) {
    roomId = newRoomId;
    roomIdDisplay.textContent = roomId;
    startLocalStream();
    showToast(`Room ${roomId} created! Share the ID`, 'success');
}

function handleRoomJoined(joinedRoomId) {
    roomId = joinedRoomId;
    roomIdDisplay.textContent = roomId;
    startLocalStream();
    showToast(`Joined room ${roomId}`, 'success');
}

function copyRoomId() {
    navigator.clipboard.writeText(roomId).then(() => {
        showToast('Room ID copied to clipboard!', 'success');
    });
}

// ── Media ─────────────────────────────────────────────
async function startLocalStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        hideConnectionStatus();
        hideJoinUI();
        showCallUI();
        startSendingVideoFrames();
    } catch (err) {
        showToast('Could not access camera/microphone', 'error');
        hideConnectionStatus();
    }
}

function toggleVideo() {
    isCameraOn = !isCameraOn;
    localStream.getVideoTracks().forEach(t => t.enabled = isCameraOn);
    toggleVideoBtn.innerHTML = isCameraOn
        ? '<i class="fas fa-video"></i>'
        : '<i class="fas fa-video-slash"></i>';
    toggleVideoBtn.classList.toggle('off', !isCameraOn);
    if (!isCameraOn) localSignText.classList.add('hidden');
}

function toggleMic() {
    isMicOn = !isMicOn;
    localStream.getAudioTracks().forEach(t => t.enabled = isMicOn);
    toggleMicBtn.innerHTML = isMicOn
        ? '<i class="fas fa-microphone"></i>'
        : '<i class="fas fa-microphone-slash"></i>';
    toggleMicBtn.classList.toggle('off', !isMicOn);
}

// ── WebRTC ────────────────────────────────────────────
function startCall() {
    createPeerConnection();
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    createAndSendOffer();
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) socket.emit('ice_candidate', { candidate: e.candidate.toJSON(), room_id: roomId });
    };

    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
            isConnected = true;
            showToast('Peer-to-peer connection established', 'success');
        }
    };

    peerConnection.ontrack = (e) => {
        if (remoteVideo.srcObject !== e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
            isRemoteVideoConnected = true;
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        const s = peerConnection.iceConnectionState;
        if (s === 'disconnected' || s === 'failed' || s === 'closed') handlePeerDisconnect();
    };

    socket.on('ice_candidate', (data) => {
        peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
            .catch(e => console.error('ICE error:', e));
    });

    socket.on('offer', async (data) => {
        if (!peerConnection) createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { answer, room_id: roomId });
    });

    socket.on('answer', async (data) => {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer))
            .catch(e => console.error('Answer error:', e));
    });
}

async function createAndSendOffer() {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', { offer, room_id: roomId });
}

// ── Video Frame Sending ───────────────────────────────
function startSendingVideoFrames() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 640;
    canvas.height = 480;

    frameInterval = setInterval(() => {
        if (localStream && isCameraOn && localVideo.videoWidth > 0) {
            ctx.drawImage(localVideo, 0, 0, canvas.width, canvas.height);
            socket.emit('video_frame', { frame: canvas.toDataURL('image/jpeg', 0.7) });
        }
    }, 200);
}

// ── Chat ──────────────────────────────────────────────
function sendChatMessage() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    const time = getCurrentTime();
    socket.emit('chat_message', { message: msg, room_id: roomId, time });
    appendChatMessage(msg, 'sent', time);
    chatInput.value = '';
}

function appendChatMessage(message, type, time) {
    const isEmpty = chatMessages.querySelector('.empty-state');
    if (isEmpty) isEmpty.remove();

    const div = document.createElement('div');
    div.className = `chat-msg ${type}`;
    div.innerHTML = `${escapeHtml(message)}<div class="msg-meta">${time}</div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Sign History ──────────────────────────────────────
function addToHistory(sign, confidence, source) {
    const isEmpty = signHistory.querySelector('.empty-state');
    if (isEmpty) isEmpty.remove();

    // Avoid duplicate consecutive entries
    const last = signHistory.querySelector('.history-item:last-child .sign-name');
    if (last && last.textContent === String(sign)) return;

    historyCount++;
    if (historyCount > 50) {
        signHistory.querySelector('.history-item')?.remove();
        historyCount--;
    }

    const pct = confidence != null ? Math.round(confidence * 100) : null;
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
        <span class="sign-name">${escapeHtml(String(sign))}</span>
        ${pct != null ? `
        <div class="confidence-bar-wrap">
            <div class="confidence-bar" style="width:${pct}%"></div>
        </div>
        <span class="confidence-label">${pct}%</span>` : ''}
        <span class="sign-source ${source === 'remote' ? 'remote' : ''}">${source}</span>
        <span class="sign-time">${getCurrentTime()}</span>
    `;
    signHistory.appendChild(item);
    signHistory.scrollTop = signHistory.scrollHeight;
}

function clearHistory() {
    signHistory.innerHTML = '<p class="empty-state">No signs detected yet...</p>';
    historyCount = 0;
}

// ── Speech to Sign ────────────────────────────────────
function setupSpeechRecognition() {
    if ('webkitSpeechRecognition' in window) {
        recognition = new webkitSpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';
        recognition.onresult = (e) => { speechText.value = e.results[0][0].transcript; };
        recognition.onerror = () => { startSpeechBtn.disabled = false; };
        recognition.onend = () => { startSpeechBtn.disabled = false; };
    } else {
        startSpeechBtn.style.display = 'none';
    }
}

function startSpeechRecognition() {
    if (recognition) {
        speechText.value = '';
        startSpeechBtn.disabled = true;
        recognition.start();
    }
}

function convertSpeechToSign() {
    const text = speechText.value.trim();
    if (text) {
        socket.emit('speech_to_sign', { text });
    } else {
        showToast('Please enter or speak some text', 'warning');
    }
}

function displaySpeechToSignResult(data) {
    signImagesContainer.innerHTML = '';
    if (!data.images.length) {
        signImagesContainer.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">No sign images found for this text.</p>';
        return;
    }
    let currentWord = '';
    data.images.forEach((path, i) => {
        const info = data.word_info[i] || {};
        if (info.type === 'word' || (info.type === 'character' && info.word !== currentWord)) {
            if (currentWord !== '') {
                const spacer = document.createElement('div');
                spacer.className = 'sign-spacer';
                signImagesContainer.appendChild(spacer);
            }
            currentWord = info.word;
        }
        const img = document.createElement('img');
        img.src = path;
        img.alt = info.type === 'character' ? info.character : info.word;
        img.className = 'sign-image';
        signImagesContainer.appendChild(img);
    });
}

// ── Toast Notifications ───────────────────────────────
function showToast(message, type = 'info') {
    const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${escapeHtml(message)}`;
    document.getElementById('toast-container').appendChild(toast);
    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ── Helpers ───────────────────────────────────────────
function updateSignText(el, sign) {
    if (sign) {
        el.textContent = sign;
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

function getCurrentTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Disconnect / Leave ────────────────────────────────
function leaveRoom() {
    clearInterval(frameInterval);
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    remoteVideo.style.backgroundImage = '';
    showJoinUI();
    hideCallUI();
    roomId = null;
    isConnected = false;
    isRemoteVideoConnected = false;
    window.location.reload();
}

function handlePeerDisconnect() {
    remoteVideo.srcObject = null;
    remoteSignText.classList.add('hidden');
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    isConnected = false;
    isRemoteVideoConnected = false;
}

function handleDisconnect() {
    showToast('Disconnected from server. Please refresh.', 'error');
    leaveRoom();
}

// ── Show/Hide UI ──────────────────────────────────────
function showJoinUI()          { joinContainer.classList.remove('hidden'); }
function hideJoinUI()          { joinContainer.classList.add('hidden'); }
function showCallUI()          { callContainer.classList.remove('hidden'); }
function hideCallUI()          { callContainer.classList.add('hidden'); }
function showConnectionStatus(){ connectionStatus.classList.remove('hidden'); }
function hideConnectionStatus(){ connectionStatus.classList.add('hidden'); }

window.addEventListener('load', init);
