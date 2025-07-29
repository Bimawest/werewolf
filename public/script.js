document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const modeSelectionScreen = document.getElementById('mode-selection-screen');
    const singlePlayerModeBtn = document.getElementById('single-player-mode-btn');
    const multiplayerModeBtn = document.getElementById('multiplayer-mode-btn');
    const desiredRoomCodeInput = document.getElementById('desired-room-code-input');

    // Single Player Elements
    const spSetupScreen = document.getElementById('single-player-setup-screen');
    const spNumPlayersInput = document.getElementById('sp-num-players');
    const spStartGameBtn = document.getElementById('sp-start-game-btn');
    const spPlayerTypeSelection = document.getElementById('sp-player-type-selection');

    // Multiplayer Elements
    const mpLobbyScreen = document.getElementById('multiplayer-lobby-screen');
    const createRoomBtn = document.getElementById('create-room-btn');
    const roomCodeInput = document.getElementById('room-code-input');
    const joinRoomBtn = document.getElementById('join-room-btn');
    const roomInfo = document.getElementById('room-info');
    const mpPlayerSetupScreen = document.getElementById('mp-player-setup-screen');
    const currentRoomCodeDisplay = document.getElementById('current-room-code-mp');
    const mpPlayerNameInput = document.getElementById('mp-player-name-input');
    const mpPlayerTypeSelect = document.getElementById('mp-player-type-select');
    const mpRegisterPlayerBtn = document.getElementById('mp-register-player-btn');
    const mpStartGameServerBtn = document.getElementById('mp-start-game-server-btn');
    const mpPlayersInRoomUl = document.getElementById('mp-players-in-room-ul');

    // Add Seat elements
    const addSeatBtn = document.getElementById('add-seat-btn');
    const addSeatModal = document.getElementById('add-seat-modal');
    const newPlayerNameInput = document.getElementById('new-player-name');
    const newPlayerTypeSelect = document.getElementById('new-player-type');
    const confirmAddSeatBtn = document.getElementById('confirm-add-seat-btn');
    const cancelAddSeatBtn = document.getElementById('cancel-add-seat-btn');

    // Shared Game Elements
    const gameScreen = document.getElementById('game-screen');
    const playersUl = document.getElementById('players-ul');
    const currentPhaseDisplay = document.getElementById('current-phase');
    const yourRoleDisplay = document.getElementById('your-role');
    const actionButtons = document.getElementById('action-buttons');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendChatBtn = document.getElementById('send-chat-btn');
    const gameOverScreen = document.getElementById('game-over-screen');
    const winnerDisplay = document.getElementById('winner-display');
    const restartGameBtn = document.getElementById('restart-game-btn');

    // --- Game Variables (Client-Side) ---
    let players = []; // Array of player objects {id, name, type, role, isAlive, ...}
    let roles = [];
    let gamePhase = ''; // 'setup', 'day', 'night', 'gameOver'
    let gameMode = null; // 'singleplayer' or 'multiplayer'

    // Single Player specific
    const spVotes = {};
    let spWerewolfKillTarget = null;
    let spDoctorProtectTarget = null;

    // Multiplayer specific
    let socket = null; // Socket.IO client instance
    let myPlayerId = null; // ID pemain ini di server
    let currentRoomCode = null;
    let myRole = null; // Peran pemain ini, hanya diketahui di client ini
    let isHost = false; // Flag to track if the current player is the host
    let myKeyword = ''; // Added: Keyword for the current player

    // List of keywords for the role display
    const keywords = [
        "Apel", "Buku", "Kursi", "Meja", "Pensil", "Gitar", "Kopi", "Teh", "Payung", "Topi",
        "Sepatu", "Roti", "Susu", "Kunci", "Cermin", "Lampu", "Pintu", "Jendela", "Sabun", "Handuk",
        "Telepon", "Dompet", "Kacamata", "Jam", "Bantal", "Selimut", "Botol", "Gelas", "Sandal", "Kaos",
        "Kucing", "Anjing", "Burung", "Ikan", "Bunga", "Pohon", "Awan", "Bintang", "Bulan", "Matahari",
        "Gunung", "Laut", "Sungai", "Jalan", "Mobil", "Sepeda", "Motor", "Pesawat", "Kereta", "Kapal"
    ];

    // --- Helper Functions ---

    // PERBAIKAN: Fungsi getRandomKeyword sekarang menerima parameter usedKeywords
    function getRandomKeyword(usedKeywords = []) {
        let availableKeywords = keywords.filter(k => !usedKeywords.includes(k));
        if (availableKeywords.length === 0) {
            // Fallback: If no unique keywords left, just pick one randomly from all
            return keywords[Math.floor(Math.random() * keywords.length)];
        }
        const randomIndex = Math.floor(Math.random() * availableKeywords.length);
        const keyword = availableKeywords[randomIndex];
        return keyword;
    }

    function addChatMessage(message, isSystem = true) {
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('chat-message');
        if (isSystem) {
            msgDiv.innerHTML = `<span style="color: #666;">[Sistem]</span> ${message}`;
        } else {
            msgDiv.innerHTML = message;
        }
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight; // Auto-scroll
    }

    function updatePlayerListUI(playerList, targetUl) {
        targetUl.innerHTML = '';
        playerList.forEach(player => {
            const li = document.createElement('li');
            li.dataset.playerId = player.id;
            // Add a class if this is the current player
            if (myPlayerId !== null && player.id === myPlayerId) {
                li.classList.add('is-me');
            }

            // Display socket ID if available, for debugging in lobby for multiplayer
            const socketIdInfo = (gameMode === 'multiplayer' && player.socketId) ? ` (${player.socketId ? player.socketId.substring(0, 4) + '...' : 'Disconnected'})` : '';
            li.innerHTML = `
                <span class="player-name">${player.name}</span>
                <span class="player-status">${player.isAlive ? 'Hidup' : 'Mati'}</span>
                ${gameMode === 'singleplayer' && player.role ? `<span class="player-role-debug" style="font-size:0.8em; color:#999;"> (${player.role})</span>` : ''}
                ${gameMode === 'multiplayer' ? `<span class="player-type-debug" style="font-size:0.8em; color:#999;"> (${player.type}${socketIdInfo})</span>` : ''}
            `;
            if (!player.isAlive) {
                li.classList.add('dead'); // Add dead class for styling
            }
            targetUl.appendChild(li);
        });
    }

    function createActionButtons(eligibleTargets, actionType, buttonText, submitEventName, extraData = {}) {
        actionButtons.innerHTML = `<h4>Pilih siapa yang ingin kamu ${buttonText.toLowerCase().replace('pilih', '')}:</h4>`;
        if (eligibleTargets.length === 0) {
            actionButtons.innerHTML += '<p>Tidak ada target yang tersedia saat ini.</p>';
            return;
        }
        eligibleTargets.forEach(target => {
            const btn = document.createElement('button');
            btn.textContent = `${buttonText} ${target.name}`;
            btn.dataset.targetId = target.id;
            btn.addEventListener('click', () => {
                if (gameMode === 'singleplayer') {
                    handleSinglePlayerAction(actionType, target.id);
                } else { // Multiplayer
                    socket.emit(submitEventName, { roomCode: currentRoomCode, voterId: myPlayerId, targetId: target.id, ...extraData });
                }
                actionButtons.innerHTML = '<p>Aksi Anda telah dicatat.</p>';
            });
            actionButtons.appendChild(btn);
        });
    }

    function showGameEnd(message) {
        gameScreen.style.display = 'none';
        gameOverScreen.style.display = 'block';
        winnerDisplay.textContent = message;
        addChatMessage('Permainan berakhir.');
        // if (socket) {
        //     socket.disconnect(); // Socket tidak lagi terputus otomatis saat game over
        // }
    }

    // --- Mode Selection ---
    singlePlayerModeBtn.addEventListener('click', () => {
        gameMode = 'singleplayer';
        modeSelectionScreen.style.display = 'none';
        spSetupScreen.style.display = 'block';
        // Inisialisasi tampilan awal Single Player
        spPlayerTypeSelection.innerHTML = ''; // Pastikan kosong
        spPlayerTypeSelection.style.display = 'none'; // Pastikan tersembunyi
        gameScreen.style.display = 'none';
        gameOverScreen.style.display = 'none';
    });

    multiplayerModeBtn.addEventListener('click', () => {
        gameMode = 'multiplayer';
        modeSelectionScreen.style.display = 'none';
        mpLobbyScreen.style.display = 'block';

        // Pastikan input custom room code terlihat saat di lobi multiplayer
        desiredRoomCodeInput.value = ''; // Kosongkan input setiap kali masuk lobi
        desiredRoomCodeInput.style.display = 'block'; // Tampilkan input
        document.querySelector('label[for="desired-room-code-input"]').style.display = 'block'; // Tampilkan labelnya

        // IMPORTANT: Change this URL to your ngrok URL or deployed server URL when in production!
        // For local development, use 'http://localhost:3000'.
        // If deployed to a cloud platform, use its public URL.
        socket = io(); // Sesuaikan dengan port server Anda

        // Initialize display for Multiplayer
        mpPlayerSetupScreen.style.display = 'none';
        gameScreen.style.display = 'none';
        gameOverScreen.style.display = 'none';

        // --- Socket.IO Event Listeners (Multiplayer) ---
        socket.on('connect', () => {
            addChatMessage(`Terhubung ke server sebagai ${socket.id.substring(0, 4)}...`, true); // System message for connection
        });

        socket.on('disconnect', () => {
            addChatMessage('Terputus dari server!', true); // System message for disconnection
            // Only alert if not a normal game over restart
            if (gamePhase !== 'gameOver') {
                alert('Koneksi terputus dari server. Silakan muat ulang halaman.');
                location.reload();
            }
        });

        socket.on('roomCreated', (roomCode) => {
            currentRoomCode = roomCode;
            isHost = true; // Set host flag
            roomInfo.textContent = `Ruangan dibuat! Kode: ${roomCode}. Bagikan ini ke temanmu.`;
            mpLobbyScreen.style.display = 'none';
            mpPlayerSetupScreen.style.display = 'block';
            currentRoomCodeDisplay.textContent = `Anda di ruangan: ${roomCode}`;
            mpStartGameServerBtn.style.display = 'block'; // Host can see start game button
            mpStartGameServerBtn.disabled = true; // Disable until enough players
            mpStartGameServerBtn.classList.add('disabled-button');
            addSeatBtn.style.display = 'block'; // Host can see add seat button
        });

        socket.on('joinedRoom', (roomCode) => {
            currentRoomCode = roomCode;
            isHost = false; // Not the host
            roomInfo.textContent = `Berhasil bergabung ke ruangan ${roomCode}.`;
            mpLobbyScreen.style.display = 'none';
            mpPlayerSetupScreen.style.display = 'block';
            currentRoomCodeDisplay.textContent = `Anda di ruangan: ${roomCode}`;
            mpStartGameServerBtn.style.display = 'none'; // Not host, cannot start game
            addSeatBtn.style.display = 'none'; // Not host, cannot add seats
        });

        socket.on('roomNotFound', () => {
            alert('Kode ruangan tidak ditemukan.');
        });

        socket.on('updatePlayerList', (updatedPlayers) => {
            players = updatedPlayers; // Update local players array with public info
            updatePlayerListUI(players, mpPlayersInRoomUl); // For setup screen
            updatePlayerListUI(players, playersUl); // For game screen

            // Only host can start if enough players are registered (min 3 total, min 1 human)
            const realHumanPlayers = players.filter(p => p.type === 'human' && p.socketId !== null).length;
            if (isHost && players.length >= 3 && realHumanPlayers >= 1) {
                mpStartGameServerBtn.disabled = false;
                mpStartGameServerBtn.classList.remove('disabled-button');
            } else if (isHost) {
                mpStartGameServerBtn.disabled = true;
                mpStartGameServerBtn.classList.add('disabled-button');
            }
        });

        socket.on('playerRegistered', (playerId) => {
            myPlayerId = playerId;
            // myKeyword = getRandomKeyword(); // PERBAIKAN: Hapus baris ini. Keyword akan dikirim dari server
            mpRegisterPlayerBtn.disabled = true;
            mpRegisterPlayerBtn.textContent = 'Terdaftar';
            mpPlayerNameInput.disabled = true;
            mpPlayerTypeSelect.disabled = true;
            alert(`Anda terdaftar sebagai ${mpPlayerNameInput.value}`);
        });

        socket.on('gameStarted', () => {
            mpPlayerSetupScreen.style.display = 'none';
            gameScreen.style.display = 'block';
            chatMessages.innerHTML = ''; // Clear chat
            addChatMessage('Game dimulai!');
            // Display initial role and keyword for the current player
            if (myRole && myKeyword) { // Will be updated by 'yourRole' event too
                yourRoleDisplay.innerHTML = `Peranmu: <strong>${myRole}</strong><br>Kata Kunci: <strong>${myKeyword}</strong>`;
            }
        });

        socket.on('yourRole', (role) => {
            myRole = role;
            // Update role display with the new role and existing keyword
            yourRoleDisplay.innerHTML = `Peranmu: <strong>${myRole}</strong><br>Kata Kunci: <strong>${myKeyword}</strong>`;
        });

        // PERBAIKAN: Tambahkan event listener untuk 'yourKeyword'
        socket.on('yourKeyword', (keyword) => {
            myKeyword = keyword; // Update the client-side keyword with the one from the server
            // Ensure the display is updated after both role and keyword are received
            if (myRole && myKeyword) {
                yourRoleDisplay.innerHTML = `Peranmu: <strong>${myRole}</strong><br>Kata Kunci: <strong>${myKeyword}</strong>`;
            }
        });


        socket.on('werewolfBuddies', (buddies) => {
            addChatMessage(`Werewolf lain adalah: ${buddies.join(', ')}.`, true);
        });

        socket.on('newChatMessage', (message) => {
            addChatMessage(message, false); // False indicates it's not a system message
        });

        socket.on('updateGamePhase', (phaseText) => {
            currentPhaseDisplay.textContent = `Fase: ${phaseText}`;
            actionButtons.innerHTML = ''; // Clear action buttons from previous phase

            // Logika untuk mengubah background
            if (phaseText.includes('Siang Hari')) { // Periksa teks fase untuk "Siang Hari"
                document.body.classList.remove('night-mode');
                document.body.classList.add('day-mode'); // Anda bisa menambah kelas 'day-mode' jika ingin gaya berbeda untuk siang
            } else if (phaseText.includes('Malam Hari')) { // Periksa teks fase untuk "Malam Hari"
                document.body.classList.add('night-mode');
                document.body.classList.remove('day-mode');
            }
        });

        socket.on('requestVote', (eligibleTargets) => {
            createActionButtons(eligibleTargets, 'vote', 'Gantung', 'submitVote');
        });

        socket.on('requestWerewolfKill', (eligibleTargets) => {
            createActionButtons(eligibleTargets, 'kill', 'Mangsa', 'submitWerewolfKill');
        });

        socket.on('requestDoctorProtect', (eligibleTargets) => {
            createActionButtons(eligibleTargets, 'protect', 'Lindungi', 'submitDoctorProtect');
        });

        socket.on('requestSeerReveal', (eligibleTargets) => {
            createActionButtons(eligibleTargets, 'reveal', 'Lihat Peran', 'submitSeerReveal');
        });

        socket.on('actionSubmitted', () => {
            // Aksi diterima server, mungkin bisa tampilkan pesan kecil
            // addChatMessage('Aksi Anda telah dicatat.', true);
        });

        socket.on('actionError', (message) => {
            alert('Aksi gagal: ' + message);
        });

        socket.on('gameOver', (winnerMessage) => {
            showGameEnd(winnerMessage);
        });
    });

    // --- Single Player Logic ---

    spStartGameBtn.addEventListener('click', () => {
        const numPlayers = parseInt(spNumPlayersInput.value);
        if (isNaN(numPlayers) || numPlayers < 3 || numPlayers > 20) {
            alert('Jumlah pemain harus antara 3 sampai 20!');
            return;
        }

        spSetupScreen.style.display = 'none'; // Sembunyikan layar setup utama
        spPlayerTypeSelection.innerHTML = ''; // Kosongkan dan siapkan area pilihan tipe pemain
        players = []; // Reset array pemain
        spWerewolfKillTarget = null;
        spDoctorProtectTarget = null;
        Object.keys(spVotes).forEach(key => delete spVotes[key]); // Clear votes

        for (let i = 0; i < numPlayers; i++) {
            const playerDiv = document.createElement('div');
            playerDiv.className = 'player-setup-item';
            playerDiv.innerHTML = `
                <label for="sp-player-name-${i}">Pemain ${i + 1}:</label>
                <input type="text" id="sp-player-name-${i}" placeholder="Nama Pemain ${i + 1}" value="Pemain ${i + 1}">
                <select id="sp-player-type-${i}">
                    <option value="human">Manusia</option>
                    <option value="computer">Komputer</option>
                </select>
            `;
            spPlayerTypeSelection.appendChild(playerDiv);
        }

        const confirmPlayersBtn = document.createElement('button');
        confirmPlayersBtn.textContent = 'Konfirmasi Pemain & Mulai Game';
        confirmPlayersBtn.addEventListener('click', confirmSinglePlayerSetup);
        spPlayerTypeSelection.appendChild(confirmPlayersBtn);
        spPlayerTypeSelection.style.display = 'block';
    });

    function confirmSinglePlayerSetup() {
        const numPlayers = parseInt(spNumPlayersInput.value);
        players = [];
        let humanPlayerFound = false;
        for (let i = 0; i < numPlayers; i++) {
            const nameInput = document.getElementById(`sp-player-name-${i}`);
            const typeSelect = document.getElementById(`sp-player-type-${i}`);
            const isHuman = typeSelect.value === 'human';
            if (isHuman) humanPlayerFound = true;

            players.push({
                id: i,
                name: nameInput.value || `Pemain ${i + 1}`,
                type: typeSelect.value,
                role: null, // Role will be assigned soon
                isAlive: true,
                hasVoted: false,
                actionChosen: false,
                // In single player, all players (even computer) get a keyword for consistency
                // PERBAIKAN: Hapus inisialisasi keyword acak di sini
                // keyword: getRandomKeyword()
            });
        }

        if (!humanPlayerFound) {
            alert('Anda harus memiliki setidaknya satu pemain manusia (Anda) di mode Single Player.');
            return; // Stay on setup screen
        }

        spPlayerTypeSelection.style.display = 'none';
        // Hanya lanjutkan jika assignRolesSinglePlayer berhasil (mengembalikan true)
        if (assignRolesSinglePlayer()) {
            startSinglePlayerGame();
        }
    }

    // Helper function to shuffle an array
    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    // --- Game Logic Functions (Single Player) ---
    function assignRolesSinglePlayer() {
        const numPlayers = players.length;
        roles = [];

        // Dynamic role assignment based on player count
        if (numPlayers >= 3 && numPlayers <= 5) {
            roles.push('Werewolf', 'Villager', 'Villager');
            if (numPlayers >= 4) roles.push('Doctor');
            if (numPlayers === 5) roles.push('Seer');
        } else if (numPlayers >= 6 && numPlayers <= 10) {
            // PERBAIKAN: Tanda kurung siku penutup ']' yang benar
            roles.push('Werewolf', 'Werewolf', 'Villager', 'Villager', 'Villager', 'Doctor', 'Seer');
            if (numPlayers >= 8) roles.push('Villager');
            if (numPlayers >= 9) roles.push('Werewolf');
            if (numPlayers === 10) roles.push('Villager');
        } else if (numPlayers > 10) {
            let numWerewolves = Math.floor(numPlayers / 4);
            if (numWerewolves < 2) numWerewolves = 2; // Min 2 werewolves for large games
            for (let i = 0; i < numWerewolves; i++) roles.push('Werewolf');
            roles.push('Doctor', 'Seer'); // Always include Doctor and Seer
            while (roles.length < numPlayers) {
                roles.push('Villager'); // Fill remaining with Villagers
            }
        } else {
            alert('Minimal 3 pemain diperlukan untuk memulai permainan.');
            return false;
        }

        roles = shuffleArray(roles); // Shuffle roles before assigning

        let commonGoodKeyword = '';
        let werewolfKeyword = '';
        let usedKeywordsForAssignment = [];

        // Select keyword for Werewolf(s)
        werewolfKeyword = getRandomKeyword(usedKeywordsForAssignment);
        usedKeywordsForAssignment.push(werewolfKeyword);

        // Select common keyword for good roles (Villager, Doctor, Seer)
        commonGoodKeyword = getRandomKeyword(usedKeywordsForAssignment);
        usedKeywordsForAssignment.push(commonGoodKeyword); // Add to used list

        players.forEach((player, index) => {
            player.role = roles[index];
            if (player.role === 'Werewolf') {
                player.keyword = werewolfKeyword;
            } else { // Villager, Doctor, Seer
                player.keyword = commonGoodKeyword;
            }
        });

        // Set the current player's role and keyword for display
        // myPlayerId akan diset setelah humanPlayer ditemukan di startSinglePlayerGame
        // Ini untuk memastikan display diupdate dengan peran dan keyword yang benar
        const humanPlayer = players.find(p => p.type === 'human');
        if (humanPlayer) {
            myPlayerId = humanPlayer.id;
            myRole = humanPlayer.role;
            myKeyword = humanPlayer.keyword;
        }


        console.log("Assigned roles and keywords (Single Player):", players.map(p => ({ name: p.name, role: p.role, keyword: p.keyword })));
        return true; // Indicate success
    }

    function startSinglePlayerGame() {
        gameScreen.style.display = 'block';
        gameOverScreen.style.display = 'none';
        updatePlayerListUI(players, playersUl);
        addChatMessage('Game dimulai! Selamat datang di desa Werewolf.');

        const humanPlayer = players.find(p => p.type === 'human');
        if (humanPlayer) {
            // myPlayerId = humanPlayer.id; // Already set in assignRolesSinglePlayer
            // myRole = humanPlayer.role;   // Already set in assignRolesSinglePlayer
            // myKeyword = humanPlayer.keyword; // Already set in assignRolesSinglePlayer
            yourRoleDisplay.innerHTML = `Peranmu: <strong>${myRole}</strong><br>Kata Kunci: <strong>${myKeyword}</strong>`;
            addChatMessage(`Hai ${humanPlayer.name}, peranmu adalah: <strong>${myRole}</strong>.`, true);
            if (myRole === 'Werewolf') {
                const otherWerewolves = players.filter(p => p.isAlive && p.id !== humanPlayer.id && p.role === 'Werewolf');
                if (otherWerewolves.length > 0) {
                    addChatMessage(`Werewolf lain adalah: ${otherWerewolves.map(p => p.name).join(', ')}.`, true);
                }
            }
        } else {
            yourRoleDisplay.textContent = `Peranmu: (Kamu adalah Pengamat)`;
            addChatMessage('Semua pemain adalah Komputer. Saksikan permainan berlangsung!', true);
            myPlayerId = -1; // Indicate observer mode for the UI
        }

        startDayPhaseSinglePlayer();
    }

    function startDayPhaseSinglePlayer() {
        gamePhase = 'day';
        currentPhaseDisplay.textContent = 'Fase: Siang Hari (Diskusi & Voting)';
        addChatMessage('Ini adalah siang hari. Diskusikan siapa yang mencurigakan.', true);
        actionButtons.innerHTML = '';
        document.body.classList.remove('night-mode');
        document.body.classList.add('day-mode'); // Pastikan ini juga di set di single player

        players.forEach(p => {
            p.hasVoted = false;
            p.actionChosen = false;
        });

        const alivePlayersCount = players.filter(p => p.isAlive).length;
        if (alivePlayersCount <= 2) {
            checkSinglePlayerGameEnd();
            return;
        }

        addChatMessage('Waktunya voting. Pilih siapa yang ingin digantung!', true);
        const humanPlayer = players.find(p => p.isAlive && p.type === 'human');
        if (humanPlayer) {
            // Target yang valid adalah pemain hidup selain diri sendiri
            createActionButtons(players.filter(p => p.isAlive && p.id !== humanPlayer.id), 'vote', 'Gantung', null);
        } else { // No human players, proceed with computer votes immediately
            setTimeout(() => {
                performComputerDayVoteSinglePlayer();
                resolveDayVoteSinglePlayer();
            }, 2000);
        }
    }

    function handleSinglePlayerAction(actionType, targetId) {
        const actingPlayer = players.find(p => p.id === myPlayerId);
        const targetPlayer = players.find(p => p.id === targetId);

        if (!actingPlayer || !actingPlayer.isAlive || actingPlayer.actionChosen) {
            addChatMessage('Anda tidak bisa melakukan aksi ini sekarang.', true);
            return;
        }

        actingPlayer.actionChosen = true; // Tandai pemain ini sudah melakukan aksi

        if (actionType === 'vote') {
            if (spVotes[targetId]) {
                spVotes[targetId]++;
            } else {
                spVotes[targetId] = 1;
            }
            actingPlayer.hasVoted = true;
            addChatMessage(`${actingPlayer.name} memilih untuk menggantung ${targetPlayer.name}.`, false);
        } else if (actionType === 'kill') {
            spWerewolfKillTarget = targetPlayer;
            addChatMessage(`${actingPlayer.name} memilih untuk membunuh ${targetPlayer.name}.`, false);
        } else if (actionType === 'protect') {
            spDoctorProtectTarget = targetPlayer;
            addChatMessage(`${actingPlayer.name} memilih untuk melindungi ${targetPlayer.name}.`, false);
        } else if (actionType === 'reveal') {
            addChatMessage(`${actingPlayer.name} melihat peran ${targetPlayer.name}. Perannya adalah <strong>${targetPlayer.role}</strong>.`, false);
        }

        // Check if all actions/votes are done to proceed
        const allAlivePlayers = players.filter(p => p.isAlive);
        if (gamePhase === 'day') {
            const allHumanVoted = allAlivePlayers.filter(p => p.type === 'human').every(p => p.hasVoted);
            if (allHumanVoted) {
                setTimeout(() => {
                    performComputerDayVoteSinglePlayer();
                    resolveDayVoteSinglePlayer();
                }, 1000);
            }
        } else if (gamePhase === 'night') {
            // In single player, we wait for human action and then trigger computer actions
            const pendingHumanActions = allAlivePlayers.filter(p => p.type === 'human' && !p.actionChosen && ['Werewolf', 'Doctor', 'Seer'].includes(p.role));
            if (pendingHumanActions.length === 0) { // All human actions done
                setTimeout(() => {
                    performComputerNightActionsSinglePlayer();
                    resolveNightActionsSinglePlayer();
                }, 1000);
            }
        }
    }

    function performComputerDayVoteSinglePlayer() {
        const aliveComputerPlayers = players.filter(p => p.isAlive && p.type === 'computer' && !p.hasVoted);

        aliveComputerPlayers.forEach(computerPlayer => {
            let targetPlayer = null;
            const eligibleTargets = players.filter(p => p.isAlive && p.id !== computerPlayer.id);

            if (eligibleTargets.length === 0) return;

            // Simple AI for computer voting
            if (computerPlayer.role === 'Werewolf') {
                const nonWerewolfTargets = eligibleTargets.filter(p => p.role !== 'Werewolf');
                targetPlayer = nonWerewolfTargets.length > 0 ? nonWerewolfTargets[Math.floor(Math.random() * nonWerewolfTargets.length)] : eligibleTargets[Math.floor(Math.random() * eligibleTargets.length)];
            } else { // Villager, Doctor, Seer (try to target werewolves)
                const werewolfTargets = eligibleTargets.filter(p => p.role === 'Werewolf');
                targetPlayer = werewolfTargets.length > 0 ? werewolfTargets[Math.floor(Math.random() * werewolfTargets.length)] : eligibleTargets[Math.floor(Math.random() * eligibleTargets.length)];
            }

            if (targetPlayer) {
                if (spVotes[targetPlayer.id]) {
                    spVotes[targetPlayer.id]++;
                } else {
                    spVotes[targetPlayer.id] = 1;
                }
                computerPlayer.hasVoted = true;
                addChatMessage(`${computerPlayer.name} (Komputer) memilih untuk menggantung ${targetPlayer.name}.`, false);
            }
        });
    }

    function resolveDayVoteSinglePlayer() {
        let maxVotes = 0;
        let playersToHang = [];

        if (Object.keys(spVotes).length === 0) {
            addChatMessage('Tidak ada yang digantung hari ini.', true);
            setTimeout(startNightPhaseSinglePlayer, 3000);
            return;
        }

        for (const targetId in spVotes) {
            if (spVotes[targetId] > maxVotes) {
                maxVotes = spVotes[targetId];
                playersToHang = [parseInt(targetId)];
            } else if (spVotes[targetId] === maxVotes) {
                playersToHang.push(parseInt(targetId));
            }
        }

        if (playersToHang.length === 1) {
            const hungPlayer = players.find(p => p.id === playersToHang[0]);
            if (hungPlayer) {
                hungPlayer.isAlive = false;
                addChatMessage(`Desa telah menggantung <strong>${hungPlayer.name}</strong>. Perannya adalah <strong>${hungPlayer.role}</strong>.`, true);
            }
        } else {
            addChatMessage('Tidak ada yang digantung hari ini karena seri suara atau tidak ada yang memilih.', true);
        }

        for (const key in spVotes) {
            delete spVotes[key]; // Clear votes for next day
        }

        updatePlayerListUI(players, playersUl);
        checkSinglePlayerGameEnd();
        if (gameScreen.style.display === 'block') { // If game not over
            setTimeout(startNightPhaseSinglePlayer, 3000);
        }
    }

    function startNightPhaseSinglePlayer() {
        gamePhase = 'night';
        currentPhaseDisplay.textContent = 'Fase: Malam Hari (Aksi Peran)';
        addChatMessage('Ini adalah malam hari. Werewolf berburu, Dokter melindungi, dan Seer melihat.', true);
        actionButtons.innerHTML = '';
        document.body.classList.add('night-mode');
        document.body.classList.remove('day-mode'); // Pastikan ini juga di set di single player

        spWerewolfKillTarget = null;
        spDoctorProtectTarget = null;
        players.forEach(p => p.actionChosen = false); // Reset actionChosen for night

        const alivePlayers = players.filter(p => p.isAlive);
        if (alivePlayers.length <= 0) { // If no players left or only one, can't continue night
            checkSinglePlayerGameEnd();
            return;
        }

        const humanWerewolf = players.find(p => p.isAlive && p.type === 'human' && p.role === 'Werewolf');
        const humanDoctor = players.find(p => p.isAlive && p.type === 'human' && p.role === 'Doctor');
        const humanSeer = players.find(p => p.isAlive && p.type === 'human' && p.role === 'Seer');
        // Add animation when werewolf kills and stop animation after a short delay
        const werewolfKillAnimation = document.createElement('div');
        werewolfKillAnimation.className = 'werewolf-kill-animation';
        werewolfKillAnimation.innerHTML = `<img src="img/werewolf-kill.gif" alt="Werewolf Kill Animation">`;
        werewolfKillAnimation.style= `position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 1000; display: flex; justify-content: center; align-items: center; background-color: rgba(0, 0, 0, 0.8);`;
        document.body.appendChild(werewolfKillAnimation);

        // Only request actions from human players if they are alive and haven't acted
        if (humanWerewolf && !humanWerewolf.actionChosen) {
            addChatMessage('Werewolf bangun. Pilih siapa yang ingin kamu mangsa.', true);
            createActionButtons(alivePlayers.filter(p => p.role !== 'Werewolf'), 'kill', 'Mangsa', null);
        }
        if (humanDoctor && !humanDoctor.actionChosen) {
            addChatMessage('Dokter bangun. Pilih siapa yang ingin kamu lindungi.', true);
            createActionButtons(alivePlayers, 'protect', 'Lindungi', null);
        }
        if (humanSeer && !humanSeer.actionChosen) {
            addChatMessage('Seer bangun. Pilih siapa yang ingin kamu lihat perannya.', true);
            createActionButtons(alivePlayers, 'reveal', 'Lihat Peran', null);
        }

        // Trigger computer actions and resolve night after a short delay
        // This ensures human player has a moment to see their options before computers act,
        // and also resolves the night if no human players or all human actions are done.
        setTimeout(() => {
            performComputerNightActionsSinglePlayer();
            resolveNightActionsSinglePlayer();
        }, 3000); // Give 3 seconds for human player to act if any
    }

    function performComputerNightActionsSinglePlayer() {
        const aliveComputerWerewolves = players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Werewolf' && !p.actionChosen);
        const aliveComputerDoctors = players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Doctor' && !p.actionChosen);
        const aliveComputerSeers = players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Seer' && !p.actionChosen);
        const alivePlayers = players.filter(p => p.isAlive);


        if (aliveComputerWerewolves.length > 0) {
            const potentialTargets = alivePlayers.filter(p => p.role !== 'Werewolf');
            if (potentialTargets.length > 0) {
                // If there's an existing human target for werewolf, stick to it or override if computer target is better
                if (!spWerewolfKillTarget || !potentialTargets.some(p => p.id === spWerewolfKillTarget.id)) { // If no human choice, or human chose an invalid target (e.g. self, or werewolf)
                    spWerewolfKillTarget = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                }
                addChatMessage(`${aliveComputerWerewolves[0].name} (Komputer Werewolf) memilih untuk membunuh ${spWerewolfKillTarget.name}.`, false);
            }
            aliveComputerWerewolves.forEach(p => p.actionChosen = true);
        }

        if (aliveComputerDoctors.length > 0) {
            // Doctor might try to protect a random player, or if human has selected, don't override
            if (!spDoctorProtectTarget) {
                const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
                spDoctorProtectTarget = target;
            }
            addChatMessage(`${aliveComputerDoctors[0].name} (Komputer Dokter) memilih untuk melindungi ${spDoctorProtectTarget.name}.`, false);
            aliveComputerDoctors.forEach(p => p.actionChosen = true);
        }

        if (aliveComputerSeers.length > 0) {
            const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            addChatMessage(`${aliveComputerSeers[0].name} (Komputer Seer) melihat peran ${target.name}.`, false);
            aliveComputerSeers.forEach(p => p.actionChosen = true);
        }
    }


    function resolveNightActionsSinglePlayer() {
        actionButtons.innerHTML = ''; // Clear action buttons

        let killedPlayer = null;

        if (spWerewolfKillTarget) {
            if (spDoctorProtectTarget && spWerewolfKillTarget.id === spDoctorProtectTarget.id) {
                addChatMessage(`Malam ini ${spWerewolfKillTarget.name} diserang Werewolf tapi diselamatkan oleh Dokter.`, true);
            } else {
                killedPlayer = players.find(p => p.id === spWerewolfKillTarget.id); // Find the actual player object
                if (killedPlayer) {
                    killedPlayer.isAlive = false;
                    addChatMessage(`Malam ini, <strong>${killedPlayer.name}</strong> dimangsa oleh Werewolf. Perannya adalah <strong>${killedPlayer.role}</strong>.`, true);
                }
            }
        } else {
            addChatMessage('Tidak ada yang dimangsa malam ini.', true);
        }

        updatePlayerListUI(players, playersUl);
        checkSinglePlayerGameEnd();
        if (gameScreen.style.display === 'block') { // If game not over
            setTimeout(startDayPhaseSinglePlayer, 3000);
        }
    }

    function checkSinglePlayerGameEnd() {
        const aliveWerewolves = players.filter(p => p.isAlive && p.role === 'Werewolf');
        const aliveVillagers = players.filter(p => p.isAlive && p.role !== 'Werewolf');
        const alivePlayersCount = players.filter(p => p.isAlive).length;

        if (aliveWerewolves.length === 0) {
            showGameEnd('Selamat! Penduduk desa memenangkan permainan!');
            gamePhase = 'gameOver';
        } else if (aliveWerewolves.length >= aliveVillagers.length) {
            showGameEnd('Maaf! Werewolf memenangkan permainan!');
            gamePhase = 'gameOver';
        } else if (alivePlayersCount < 3 && gamePhase !== 'gameOver') { // Prevent re-triggering if already over
            showGameEnd('Permainan berakhir karena jumlah pemain terlalu sedikit!');
            gamePhase = 'gameOver';
        }
    }

    // --- Multiplayer UI Event Listeners ---
    createRoomBtn.addEventListener('click', () => {
        const customRoomCode = desiredRoomCodeInput.value.trim().toUpperCase();
        // Kirim kode kustom ke server. Jika kosong, server akan meng-generate sendiri.
        socket.emit('createRoom', customRoomCode);
    });

    joinRoomBtn.addEventListener('click', () => {
        const roomCode = roomCodeInput.value.trim().toUpperCase();
        if (roomCode) {
            socket.emit('joinRoom', roomCode);
        } else {
            alert('Masukkan kode ruangan!');
        }
    });

    mpRegisterPlayerBtn.addEventListener('click', () => {
        const playerName = mpPlayerNameInput.value.trim();
        const playerType = mpPlayerTypeSelect.value;
        if (playerName && currentRoomCode) {
            socket.emit('playerSetup', { roomCode: currentRoomCode, playerName, playerType });
        } else {
            alert('Nama pemain dan kode ruangan harus ada.');
        }
    });

    mpStartGameServerBtn.addEventListener('click', () => {
        // The server-side check for min players is more authoritative, but a client-side hint is good.
        if (currentRoomCode) {
            socket.emit('startGame', currentRoomCode);
        } else {
            alert('Terjadi kesalahan. Coba lagi.');
        }
    });

    // New: Add Seat functionality
    addSeatBtn.addEventListener('click', () => {
        if (isHost) {
            addSeatModal.style.display = 'flex'; // Show the modal using flex for centering
            newPlayerNameInput.value = 'Komputer ' + (players.length + 1); // Default name for computer
            newPlayerTypeSelect.value = 'computer'; // Default type
        } else {
            alert('Hanya host yang bisa menambahkan kursi.');
        }
    });

    confirmAddSeatBtn.addEventListener('click', () => {
        const playerName = newPlayerNameInput.value.trim();
        const playerType = newPlayerTypeSelect.value; // 'human' or 'computer'
        if (playerName && currentRoomCode) {
            socket.emit('addPlayerToRoom', { roomCode: currentRoomCode, playerName, playerType: playerType });
            addSeatModal.style.display = 'none'; // Hide the modal
        } else {
            alert('Nama pemain tidak boleh kosong.');
        }
    });

    cancelAddSeatBtn.addEventListener('click', () => {
        addSeatModal.style.display = 'none'; // Hide the modal
    });

    sendChatBtn.addEventListener('click', () => {
        const message = chatInput.value.trim();
        if (message && currentRoomCode && myPlayerId !== null && gameMode === 'multiplayer') {
            socket.emit('chatMessage', { roomCode: currentRoomCode, senderId: myPlayerId, message });
            chatInput.value = '';
        } else if (message && gameMode === 'singleplayer') {
            const myPlayer = players.find(p => p.id === myPlayerId);
            const senderName = myPlayer ? myPlayer.name : 'Anda'; // Use player name if available
            addChatMessage(`<strong>${senderName}:</strong> ${message}`, false);
            chatInput.value = '';
        }
    });

    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendChatBtn.click();
        }
    });

    restartGameBtn.addEventListener('click', () => {
        if (gameMode === 'multiplayer' && isHost) {
            // Beri tahu server bahwa host ingin me-restart game
            socket.emit('restartGame', currentRoomCode);
        }
        // Disconnect setelah restart game diinisiasi
        if (socket) {
            socket.disconnect(); // Baru putuskan koneksi di sini
        }
        location.reload(); // Muat ulang halaman setelah disconnect
    });

    // --- Initial Display ---
    modeSelectionScreen.style.display = 'block';
    spSetupScreen.style.display = 'none';
    mpLobbyScreen.style.display = 'none';
    mpPlayerSetupScreen.style.display = 'none';
    gameScreen.style.display = 'none';
    gameOverScreen.style.display = 'none';
    addSeatModal.style.display = 'none'; // Ensure modal is hidden on load

    document.body.classList.remove('night-mode'); // Default to day mode on load
});
