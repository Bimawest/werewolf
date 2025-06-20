document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const modeSelectionScreen = document.getElementById('mode-selection-screen');
    const singlePlayerModeBtn = document.getElementById('single-player-mode-btn');
    const multiplayerModeBtn = document.getElementById('multiplayer-mode-btn');

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

    // --- Helper Functions ---

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
            // Display socket ID if available, for debugging in lobby for multiplayer
            const socketIdInfo = (gameMode === 'multiplayer' && player.socketId) ? ` (${player.socketId.substring(0, 4)}...)` : '';
            li.innerHTML = `
                <span class="player-name">${player.name}</span>
                <span class="player-status">${player.isAlive ? 'Hidup' : 'Mati'}</span>
                ${gameMode === 'singleplayer' && player.role ? `<span class="player-role-debug" style="font-size:0.8em; color:#999;"> (${player.role})</span>` : ''}
                ${gameMode === 'multiplayer' ? `<span class="player-type-debug" style="font-size:0.8em; color:#999;"> (${player.type}${socketIdInfo})</span>` : ''}
            `;
            if (!player.isAlive) {
                li.style.textDecoration = 'line-through';
                li.style.color = '#aaa';
            }
            targetUl.appendChild(li);
        });
    }

    function createActionButtons(eligibleTargets, actionType, buttonText, submitEventName, extraData = {}) {
        actionButtons.innerHTML = `<h4>Pilih siapa yang ingin kamu ${buttonText.toLowerCase().replace('pilih', '')}:</h4>`;
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
        
        // IMPORTANT: Change this URL to your ngrok URL or deployed server URL when in production!
        // For local development, use 'http://localhost:8158'.
        // If deployed to a cloud platform, use its public URL.
        socket = io('http://localhost:3000'); // Sesuaikan dengan port server Anda

        // Initialize display for Multiplayer
        mpPlayerSetupScreen.style.display = 'none';
        gameScreen.style.display = 'none';
        gameOverScreen.style.display = 'none';

        // --- Socket.IO Event Listeners (Multiplayer) ---
        socket.on('connect', () => {
            addChatMessage(`Terhubung ke server sebagai ${socket.id}`, false);
        });

        socket.on('disconnect', () => {
            addChatMessage('Terputus dari server!', false);
            alert('Koneksi terputus dari server. Silakan muat ulang halaman.');
            location.reload();
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
        });

        socket.on('yourRole', (role) => {
            myRole = role;
            yourRoleDisplay.innerHTML = `Peranmu: <strong>${myRole}</strong>`;
        });

        socket.on('werewolfBuddies', (buddies) => {
            addChatMessage(`Werewolf lain adalah: ${buddies.join(', ')}.`);
        });

        socket.on('newChatMessage', (message) => {
            addChatMessage(message, false); // False indicates it's not a system message
        });

        socket.on('updateGamePhase', (phaseText) => {
            currentPhaseDisplay.textContent = `Fase: ${phaseText}`;
            actionButtons.innerHTML = ''; // Bersihkan tombol aksi dari fase sebelumnya
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
                <label>Pemain ${i + 1}:</label>
                <input type="text" id="sp-player-name-${i}" placeholder="Nama Pemain ${i + 1}" value="Pemain ${i + 1}">
                <select id="sp-player-type-${i}">
                    <option value="human">Manusia</option>
                    <option value="computer">Komputer</option>
                </select>
            `;
            spPlayerTypeSelection.appendChild(playerDiv);
        }

        const confirmPlayersBtn = document.createElement('button');
        confirmPlayersBtn.textContent = 'Konfirmasi Pemain';
        confirmPlayersBtn.addEventListener('click', confirmSinglePlayerSetup);
        spPlayerTypeSelection.appendChild(confirmPlayersBtn);
        spPlayerTypeSelection.style.display = 'block';
    });

    function confirmSinglePlayerSetup() {
        const numPlayers = parseInt(spNumPlayersInput.value);
        players = [];
        for (let i = 0; i < numPlayers; i++) {
            const nameInput = document.getElementById(`sp-player-name-${i}`);
            const typeSelect = document.getElementById(`sp-player-type-${i}`);
            players.push({
                id: i,
                name: nameInput.value || `Pemain ${i + 1}`,
                type: typeSelect.value,
                role: null, // Role will be assigned soon
                isAlive: true,
                hasVoted: false,
                actionChosen: false
            });
        }
        spPlayerTypeSelection.style.display = 'none';
        assignRolesSinglePlayer();
        startSinglePlayerGame();
    }

    function assignRolesSinglePlayer() {
        const numPlayers = players.length;
        roles = [];

        if (numPlayers >= 3 && numPlayers <= 5) {
            roles.push('Werewolf', 'Villager', 'Villager');
            if (numPlayers >= 4) roles.push('Doctor');
            if (numPlayers === 5) roles.push('Seer');
        } else if (numPlayers >= 6 && numPlayers <= 10) {
            roles.push('Werewolf', 'Werewolf', 'Villager', 'Villager', 'Villager', 'Doctor', 'Seer');
            if (numPlayers >= 8) roles.push('Villager');
            if (numPlayers >= 9) roles.push('Werewolf');
            if (numPlayers === 10) roles.push('Villager');
        } else {
            let numWerewolves = Math.floor(numPlayers / 4);
            if (numWerewolves < 2) numWerewolves = 2; // Ensure at least 2 werewolves for larger games
            for (let i = 0; i < numWerewolves; i++) roles.push('Werewolf');
            roles.push('Doctor', 'Seer');
            while (roles.length < numPlayers) {
                roles.push('Villager');
            }
        }
        roles.sort(() => Math.random() - 0.5);
        players.forEach((player, index) => {
            player.role = roles[index];
        });
    }

    function startSinglePlayerGame() {
        gameScreen.style.display = 'block';
        gameOverScreen.style.display = 'none';
        updatePlayerListUI(players, playersUl);
        addChatMessage('Game dimulai! Selamat datang di desa Werewolf.');

        const humanPlayer = players.find(p => p.type === 'human');
        if (humanPlayer) {
            myPlayerId = humanPlayer.id; // Set myPlayerId for single player (current user)
            myRole = humanPlayer.role;
            yourRoleDisplay.textContent = `Peranmu: ${myRole}`;
            addChatMessage(`Hai ${humanPlayer.name}, peranmu adalah: <strong>${myRole}</strong>.`);
            if (myRole === 'Werewolf') {
                const otherWerewolves = players.filter(p => p.isAlive && p.id !== humanPlayer.id && p.role === 'Werewolf');
                if (otherWerewolves.length > 0) {
                    addChatMessage(`Werewolf lain adalah: ${otherWerewolves.map(p => p.name).join(', ')}.`);
                }
            }
        } else {
            yourRoleDisplay.textContent = `Peranmu: (Kamu adalah Pengamat)`;
            addChatMessage('Semua pemain adalah Komputer. Saksikan permainan berlangsung!');
            myPlayerId = -1; // Indicate observer mode for the UI
        }

        startDayPhaseSinglePlayer();
    }

    function startDayPhaseSinglePlayer() {
        gamePhase = 'day';
        currentPhaseDisplay.textContent = 'Fase: Siang Hari (Diskusi & Voting)';
        addChatMessage('Ini adalah siang hari. Diskusikan siapa yang mencurigakan.');
        actionButtons.innerHTML = '';

        players.forEach(p => {
            p.hasVoted = false;
            p.actionChosen = false;
        });

        const alivePlayersCount = players.filter(p => p.isAlive).length;
        if (alivePlayersCount <= 2) {
            checkSinglePlayerGameEnd();
            return;
        }

        addChatMessage('Waktunya voting. Pilih siapa yang ingin digantung!');
        const humanPlayer = players.find(p => p.isAlive && p.type === 'human');
        if (humanPlayer) {
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
            addChatMessage('Anda tidak bisa melakukan aksi ini sekarang.');
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
            addChatMessage(`${actingPlayer.name} memilih untuk menggantung ${targetPlayer.name}.`);
        } else if (actionType === 'kill') {
            spWerewolfKillTarget = targetPlayer;
            addChatMessage(`${actingPlayer.name} memilih untuk membunuh ${targetPlayer.name}.`);
        } else if (actionType === 'protect') {
            spDoctorProtectTarget = targetPlayer;
            addChatMessage(`${actingPlayer.name} memilih untuk melindungi ${targetPlayer.name}.`);
        } else if (actionType === 'reveal') {
            addChatMessage(`${actingPlayer.name} melihat peran ${targetPlayer.name}. Perannya adalah <strong>${targetPlayer.role}</strong>.`);
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
                addChatMessage(`${computerPlayer.name} (Komputer) memilih untuk menggantung ${targetPlayer.name}.`);
            }
        });
    }

    function resolveDayVoteSinglePlayer() {
        let maxVotes = 0;
        let playersToHang = [];

        if (Object.keys(spVotes).length === 0) {
            addChatMessage('Tidak ada yang digantung hari ini.');
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
                addChatMessage(`Desa telah menggantung <strong>${hungPlayer.name}</strong>. Perannya adalah <strong>${hungPlayer.role}</strong>.`);
            }
        } else {
            addChatMessage('Tidak ada yang digantung hari ini karena seri suara atau tidak ada yang memilih.');
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
        addChatMessage('Ini adalah malam hari. Werewolf berburu, Dokter melindungi, dan Seer melihat.');
        actionButtons.innerHTML = '';

        spWerewolfKillTarget = null;
        spDoctorProtectTarget = null;
        players.forEach(p => p.actionChosen = false); // Reset actionChosen for night

        const alivePlayers = players.filter(p => p.isAlive);
        if (alivePlayers.length === 0) {
            checkSinglePlayerGameEnd();
            return;
        }

        const humanWerewolf = players.find(p => p.isAlive && p.type === 'human' && p.role === 'Werewolf');
        const humanDoctor = players.find(p => p.isAlive && p.type === 'human' && p.role === 'Doctor');
        const humanSeer = players.find(p => p.isAlive && p.type === 'human' && p.role === 'Seer');

        if (humanWerewolf) {
            addChatMessage('Werewolf bangun. Pilih siapa yang ingin kamu mangsa.');
            createActionButtons(alivePlayers.filter(p => p.role !== 'Werewolf'), 'kill', 'Mangsa', null);
        }
        if (humanDoctor) {
            addChatMessage('Dokter bangun. Pilih siapa yang ingin kamu lindungi.');
            createActionButtons(alivePlayers, 'protect', 'Lindungi', null);
        }
        if (humanSeer) {
            addChatMessage('Seer bangun. Pilih siapa yang ingin kamu lihat perannya.');
            createActionButtons(alivePlayers, 'reveal', 'Lihat Peran', null);
        }

        // If no human special roles or they have already acted, trigger computer actions
        const allHumanSpecialRolesActed = (!humanWerewolf || humanWerewolf.actionChosen) &&
                                          (!humanDoctor || humanDoctor.actionChosen) &&
                                          (!humanSeer || humanSeer.actionChosen);
        if (allHumanSpecialRolesActed) {
             setTimeout(() => {
                performComputerNightActionsSinglePlayer();
                resolveNightActionsSinglePlayer();
            }, 1000);
        }
    }

    function performComputerNightActionsSinglePlayer() {
        const aliveComputerWerewolves = players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Werewolf' && !p.actionChosen);
        const aliveComputerDoctors = players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Doctor' && !p.actionChosen);
        const aliveComputerSeers = players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Seer' && !p.actionChosen);

        if (aliveComputerWerewolves.length > 0) {
            const potentialTargets = players.filter(p => p.isAlive && p.role !== 'Werewolf');
            if (potentialTargets.length > 0) {
                spWerewolfKillTarget = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                addChatMessage(`${aliveComputerWerewolves[0].name} (Komputer Werewolf) memilih untuk membunuh ${spWerewolfKillTarget.name}.`);
            }
            aliveComputerWerewolves.forEach(p => p.actionChosen = true);
        }

        if (aliveComputerDoctors.length > 0) {
            const target = players.filter(p => p.isAlive)[Math.floor(Math.random() * players.filter(p => p.isAlive).length)];
            spDoctorProtectTarget = target;
            addChatMessage(`${aliveComputerDoctors[0].name} (Komputer Dokter) memilih untuk melindungi ${spDoctorProtectTarget.name}.`);
            aliveComputerDoctors.forEach(p => p.actionChosen = true);
        }

        if (aliveComputerSeers.length > 0) {
            const target = players.filter(p => p.isAlive)[Math.floor(Math.random() * players.filter(p => p.isAlive).length)];
            addChatMessage(`${aliveComputerSeers[0].name} (Komputer Seer) melihat peran ${target.name}.`);
            aliveComputerSeers.forEach(p => p.actionChosen = true);
        }
    }

    function resolveNightActionsSinglePlayer() {
        actionButtons.innerHTML = ''; // Clear action buttons

        let killedPlayer = null;

        if (spWerewolfKillTarget) {
            if (spDoctorProtectTarget && spWerewolfKillTarget.id === spDoctorProtectTarget.id) {
                addChatMessage(`Malam ini ${spWerewolfKillTarget.name} diserang Werewolf tapi diselamatkan oleh Dokter.`);
            } else {
                killedPlayer = spWerewolfKillTarget;
                killedPlayer.isAlive = false;
                addChatMessage(`Malam ini, <strong>${killedPlayer.name}</strong> dimangsa oleh Werewolf. Perannya adalah <strong>${killedPlayer.role}</strong>.`);
            }
        } else {
            addChatMessage('Tidak ada yang dimangsa malam ini.');
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
        } else if (alivePlayersCount < 3) {
            showGameEnd('Permainan berakhir karena jumlah pemain terlalu sedikit!');
            gamePhase = 'gameOver';
        }
    }

    // --- Multiplayer UI Event Listeners ---
    createRoomBtn.addEventListener('click', () => {
        socket.emit('createRoom');
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
        if (currentRoomCode && players.length >= 3) { // Use 'players' array from socket updates
            socket.emit('startGame', currentRoomCode);
        } else {
            alert('Minimal 3 pemain untuk memulai game.'); // Perbaikan: titik koma berlebih dihapus
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
            // When adding via button, we treat 'human' as a computer-controlled placeholder for simplicity
            // A real "human" would connect via their own browser and join the room.
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
            addChatMessage(`<strong>Kamu:</strong> ${message}`, false);
            chatInput.value = '';
        }
    });

    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendChatBtn.click();
        }
    });

    restartGameBtn.addEventListener('click', () => {
        location.reload(); // Simplest way to restart for both modes
    });

    // --- Initial Display ---
    modeSelectionScreen.style.display = 'block';
    spSetupScreen.style.display = 'none';
    mpLobbyScreen.style.display = 'none';
    mpPlayerSetupScreen.style.display = 'none';
    gameScreen.style.display = 'none';
    gameOverScreen.style.display = 'none';
    addSeatModal.style.display = 'none'; // Ensure modal is hidden on load
});
