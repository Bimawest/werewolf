const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files (index.html, style.css, script.js)
app.use(express.static(path.join(__dirname, 'public')));

// Store game rooms and their states
const rooms = {}; // Structure: { 'ROOMCODE': { hostSocketId: '...', players: [], gameState: {} } }

// Game configuration (roles based on player count)
const GAME_ROLES = {
    '3-5': ['Werewolf', 'Villager', 'Villager', 'Doctor', 'Seer'], // Min 3, max 5. Roles added up to 5 players.
    '6-10': ['Werewolf', 'Werewolf', 'Villager', 'Villager', 'Villager', 'Doctor', 'Seer', 'Villager', 'Werewolf', 'Villager'], // Roles added up to 10 players.
    'default': ['Werewolf', 'Villager'] // Base roles, will be expanded
};

// Helper function to generate a random room code
function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]); // Ensure unique code
    return code;
}

// Helper function to shuffle an array
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Helper to get public player info
function getPublicPlayers(roomCode) {
    if (!rooms[roomCode]) return [];
    return rooms[roomCode].players.map(p => ({
        id: p.id,
        name: p.name,
        type: p.type, // 'human' or 'computer'
        isAlive: p.isAlive,
        socketId: p.socketId // Include socketId for lobby display
    }));
}

// --- Game Logic Functions ---

function assignRoles(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const numPlayers = room.players.length;
    let rolesToAssign = [];

    if (numPlayers >= 3 && numPlayers <= 5) {
        rolesToAssign = ['Werewolf', 'Villager', 'Villager'];
        if (numPlayers >= 4) rolesToAssign.push('Doctor');
        if (numPlayers === 5) rolesToAssign.push('Seer');
    } else if (numPlayers >= 6 && numPlayers <= 10) {
        rolesToAssign = ['Werewolf', 'Werewolf', 'Villager', 'Villager', 'Villager', 'Doctor', 'Seer'];
        if (numPlayers >= 8) rolesToAssign.push('Villager');
        if (numPlayers >= 9) rolesToAssign.push('Werewolf');
        if (numPlayers === 10) rolesToAssign.push('Villager');
    } else if (numPlayers > 10) { // For larger games, scale roles
        let numWerewolves = Math.floor(numPlayers / 4);
        if (numWerewolves < 2) numWerewolves = 2; // At least 2 werewolves
        for (let i = 0; i < numWerewolves; i++) rolesToAssign.push('Werewolf');
        rolesToAssign.push('Doctor', 'Seer');
        while (rolesToAssign.length < numPlayers) {
            rolesToAssign.push('Villager');
        }
    } else { // Fallback for less than 3 players (should be prevented by client/host)
        console.warn(`Attempted to assign roles for ${numPlayers} players in room ${roomCode}. Min 3 required.`); // Ini baris 82 yang tadi error
        return;
    }

    rolesToAssign = shuffleArray(rolesToAssign);

    room.players.forEach((player, index) => {
        player.role = rolesToAssign[index];
        // Send individual role to each player
        if (player.type === 'human' && player.socketId) {
            io.to(player.socketId).emit('yourRole', player.role);
            if (player.role === 'Werewolf') {
                const werewolfBuddies = room.players
                    .filter(p => p.role === 'Werewolf' && p.id !== player.id && p.isAlive)
                    .map(p => p.name);
                io.to(player.socketId).emit('werewolfBuddies', werewolfBuddies);
            }
        }
    });

    room.gameState.rolesAssigned = true;
    console.log(`Roles assigned for room ${roomCode}:`, room.players.map(p => ({ name: p.name, role: p.role })));
    addSystemMessage(roomCode, 'Peran telah dibagikan. Selamat bermain!');
}

function startGame(roomCode) {
    try {
        const room = rooms[roomCode];
        if (!room) return;

        // Reset game state
        room.gameState = {
            phase: 'night', // Start at night (Werewolves act first)
            dayNum: 0,
            votes: {}, // {playerId: count} for lynching
            werewolfKillTarget: null,
            doctorProtectTarget: null,
            seerRevealTarget: null,
            actionsTaken: {}, // {socketId: {werewolf: true, doctor: true, seer: true}}
            deadPlayersQueue: [], // Players to be announced dead
            rolesAssigned: false
        };

        // Reset players state
        room.players.forEach(p => {
            p.isAlive = true;
            p.hasVoted = false; // Reset voting status for new game
            p.actionChosen = false; // Reset action status
            p.voteTarget = null; // Clear previous vote targets
        });

        assignRoles(roomCode);

        if (!room.gameState.rolesAssigned) {
            addSystemMessage(roomCode, 'Gagal memulai game: penugasan peran tidak berhasil.');
            return;
        }

        io.to(roomCode).emit('gameStarted');
        addSystemMessage(roomCode, 'Game dimulai! Selamat datang di desa Werewolf.');
        startNightPhase(roomCode);
    } catch (error) {
        console.error(`[ERROR] startGame for room ${roomCode} failed:`, error);
        addSystemMessage(roomCode, `Terjadi kesalahan internal saat memulai game.`);
    }
}

function startDayPhase(roomCode) {
    try {
        const room = rooms[roomCode];
        if (!room) return;

        room.gameState.phase = 'day';
        room.gameState.dayNum++;
        room.gameState.votes = {}; // Reset votes for new day
        room.players.forEach(p => {
            p.hasVoted = false;
            p.actionChosen = false;
        });

        // Announce night's casualties if any
        if (room.gameState.deadPlayersQueue.length > 0) {
            room.gameState.deadPlayersQueue.forEach(deadPlayer => {
                addSystemMessage(roomCode, `Malam ini, **${deadPlayer.name}** dimangsa oleh Werewolf. Perannya adalah **${deadPlayer.role}**.`);
            });
            room.gameState.deadPlayersQueue = []; // Clear queue
        } else {
            addSystemMessage(roomCode, 'Tidak ada yang dimangsa malam ini.');
        }

        io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode)); // Update list after deaths
        checkGameEnd(roomCode);

        if (room.gameState.phase === 'day') { // If game not over
            addSystemMessage(roomCode, `Ini adalah Siang Hari ke-${room.gameState.dayNum}. Diskusikan siapa yang mencurigakan!`);
            io.to(roomCode).emit('updateGamePhase', `Siang Hari ke-${room.gameState.dayNum} (Diskusi & Voting)`);

            const alivePlayers = room.players.filter(p => p.isAlive);
            io.to(roomCode).emit('requestVote', alivePlayers.map(p => ({ id: p.id, name: p.name })));

            setTimeout(() => {
                const currentRoom = rooms[roomCode];
                if (!currentRoom || currentRoom.gameState.phase !== 'day') {
                    console.log(`[DEBUG] Skipping day phase resolution for room ${roomCode}: Room not found or phase changed.`);
                    return;
                }
                try { // try-catch di dalam timeout
                    processComputerVotes(roomCode);
                    resolveDayVote(roomCode);
                } catch (timeoutError) {
                    console.error(`[ERROR] Timeout callback for day phase in room ${roomCode} failed:`, timeoutError);
                }
            }, 10000); // Give 10 seconds for human players to vote, then computers vote
        }
    } catch (error) {
        console.error(`[ERROR] startDayPhase for room ${roomCode} failed:`, error);
        addSystemMessage(roomCode, `Terjadi kesalahan internal saat memulai siang hari.`);
    }
}

function processComputerVotes(roomCode) {
    try {
        const room = rooms[roomCode];
        if (!room) return;

        const aliveComputerPlayers = room.players.filter(p => p.isAlive && p.type === 'computer' && !p.hasVoted);

        aliveComputerPlayers.forEach(computerPlayer => {
            let targetPlayer = null;
            const eligibleTargets = room.players.filter(p => p.isAlive && p.id !== computerPlayer.id);

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
                if (room.gameState.votes[targetPlayer.id]) {
                    room.gameState.votes[targetPlayer.id]++;
                } else {
                    room.gameState.votes[targetPlayer.id] = 1;
                }
                computerPlayer.hasVoted = true;
                addSystemMessage(roomCode, `${computerPlayer.name} (Komputer) memilih untuk menggantung ${targetPlayer.name}.`);
            }
        });
    } catch (error) {
        console.error(`[ERROR] processComputerVotes for room ${roomCode} failed:`, error);
    }
}

function resolveDayVote(roomCode) {
    try {
        const room = rooms[roomCode];
        if (!room) return;

        let maxVotes = 0;
        let playersToHang = [];

        const allHumanVoted = room.players.filter(p => p.isAlive && p.type === 'human').every(p => p.hasVoted);

        if (!allHumanVoted) {
            addSystemMessage(roomCode, 'Tidak semua pemain manusia selesai voting. Menunggu...');
            return;
        }

        if (Object.keys(room.gameState.votes).length === 0) {
            addSystemMessage(roomCode, 'Tidak ada yang digantung hari ini karena tidak ada suara.');
            setTimeout(() => {
                const currentRoom = rooms[roomCode];
                if (!currentRoom || currentRoom.gameState.phase === 'gameOver') {
                    console.log(`[DEBUG] Skipping night phase start for room ${roomCode}: Room not found or game is over.`);
                    return;
                }
                try { // try-catch di dalam timeout
                    startNightPhase(roomCode);
                } catch (timeoutError) {
                    console.error(`[ERROR] Timeout callback for resolveDayVote (no votes) in room ${roomCode} failed:`, timeoutError);
                }
            }, 3000);
            return;
        }

        for (const targetId in room.gameState.votes) {
            if (room.gameState.votes[targetId] > maxVotes) {
                maxVotes = room.gameState.votes[targetId];
                playersToHang = [parseInt(targetId)];
            } else if (room.gameState.votes[targetId] === maxVotes) {
                playersToHang.push(parseInt(targetId));
            }
        }

        if (playersToHang.length === 1) {
            const hungPlayer = room.players.find(p => p.id === playersToHang[0]);
            if (hungPlayer) {
                hungPlayer.isAlive = false;
                addSystemMessage(roomCode, `Desa telah menggantung **${hungPlayer.name}**. Perannya adalah **${hungPlayer.role}**.`);
                io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
            }
        } else {
            addSystemMessage(roomCode, 'Tidak ada yang digantung hari ini karena seri suara.');
        }

        checkGameEnd(roomCode);
        if (room.gameState.phase === 'day') { // If game not over
            setTimeout(() => {
                const currentRoom = rooms[roomCode];
                if (!currentRoom || currentRoom.gameState.phase === 'gameOver') {
                    console.log(`[DEBUG] Skipping night phase start for room ${roomCode}: Room not found or game is over.`);
                    return;
                }
                try { // try-catch di dalam timeout
                    startNightPhase(roomCode);
                } catch (timeoutError) {
                    console.error(`[ERROR] Timeout callback for resolveDayVote (game not over) in room ${roomCode} failed:`, timeoutError);
                }
            }, 3000);
        }
    } catch (error) {
        console.error(`[ERROR] resolveDayVote for room ${roomCode} failed:`, error);
        addSystemMessage(roomCode, `Terjadi kesalahan internal saat menyelesaikan voting siang hari.`);
    }
}

function startNightPhase(roomCode) {
    try {
        const room = rooms[roomCode];
        if (!room) return;

        room.gameState.phase = 'night';
        room.gameState.werewolfKillTarget = null;
        room.gameState.doctorProtectTarget = null;
        room.gameState.seerRevealTarget = null;
        room.players.forEach(p => p.actionChosen = false); // Reset for night actions

        io.to(roomCode).emit('updateGamePhase', 'Malam Hari (Aksi Peran)');
        addSystemMessage(roomCode, 'Ini adalah malam hari. Werewolf berburu, Dokter melindungi, dan Seer melihat.');

        const aliveWerewolves = room.players.filter(p => p.isAlive && p.role === 'Werewolf');
        const aliveDoctors = room.players.filter(p => p.isAlive && p.role === 'Doctor');
        const aliveSeers = room.players.filter(p => p.isAlive && p.role === 'Seer');
        const alivePlayers = room.players.filter(p => p.isAlive);

        // Request actions from human players with special roles
        aliveWerewolves.forEach(p => {
            if (p.type === 'human' && p.socketId) {
                io.to(p.socketId).emit('requestWerewolfKill', alivePlayers.filter(ap => ap.role !== 'Werewolf').map(ap => ({ id: ap.id, name: ap.name })));
            }
        });
        aliveDoctors.forEach(p => {
            if (p.type === 'human' && p.socketId) {
                io.to(p.socketId).emit('requestDoctorProtect', alivePlayers.map(ap => ({ id: ap.id, name: ap.name })));
            }
        });
        aliveSeers.forEach(p => {
            if (p.type === 'human' && p.socketId) {
                io.to(p.socketId).emit('requestSeerReveal', alivePlayers.map(ap => ({ id: ap.id, name: ap.name })));
            }
        });

        setTimeout(() => {
            const currentRoom = rooms[roomCode];
            if (!currentRoom || currentRoom.gameState.phase !== 'night') {
                console.log(`[DEBUG] Skipping night action resolution for room ${roomCode}: Room not found or phase changed.`);
                return;
            }
            try { // try-catch di dalam timeout
                processComputerNightActions(roomCode);
                resolveNightActions(roomCode);
            } catch (timeoutError) {
                console.error(`[ERROR] Timeout callback for night phase in room ${roomCode} failed:`, timeoutError);
            }
        }, 5000); // Give 5 seconds for human players to make night actions
    } catch (error) {
        console.error(`[ERROR] startNightPhase for room ${roomCode} failed:`, error);
        addSystemMessage(roomCode, `Terjadi kesalahan internal saat memulai malam hari.`);
    }
}

function processComputerNightActions(roomCode) {
    try {
        const room = rooms[roomCode];
        if (!room) return;

        const aliveComputerWerewolves = room.players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Werewolf' && !p.actionChosen);
        const aliveComputerDoctors = room.players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Doctor' && !p.actionChosen);
        const aliveComputerSeers = room.players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Seer' && !p.actionChosen);
        const alivePlayers = room.players.filter(p => p.isAlive);

        if (aliveComputerWerewolves.length > 0 && !room.gameState.werewolfKillTarget) {
            const potentialTargets = alivePlayers.filter(p => p.role !== 'Werewolf');
            if (potentialTargets.length > 0) {
                room.gameState.werewolfKillTarget = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                addSystemMessage(roomCode, `${aliveComputerWerewolves[0].name} (Komputer Werewolf) memilih untuk membunuh ${room.gameState.werewolfKillTarget.name}.`);
            }
        }
        aliveComputerWerewolves.forEach(p => p.actionChosen = true);


        if (aliveComputerDoctors.length > 0 && !room.gameState.doctorProtectTarget) {
            const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            room.gameState.doctorProtectTarget = target;
            addSystemMessage(roomCode, `${aliveComputerDoctors[0].name} (Komputer Dokter) memilih untuk melindungi ${room.gameState.doctorProtectTarget.name}.`);
        }
        aliveComputerDoctors.forEach(p => p.actionChosen = true);


        if (aliveComputerSeers.length > 0 && !room.gameState.seerRevealTarget) {
            const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            room.gameState.seerRevealTarget = target; // Store for logging purposes if needed
            addSystemMessage(roomCode, `${aliveComputerSeers[0].name} (Komputer Seer) melihat peran ${target.name}. Perannya adalah ${target.role}.`);
        }
        aliveComputerSeers.forEach(p => p.actionChosen = true);
    } catch (error) {
        console.error(`[ERROR] processComputerNightActions for room ${roomCode} failed:`, error);
    }
}

function resolveNightActions(roomCode) {
    try {
        const room = rooms[roomCode];
        if (!room) return;

        let killedPlayer = null;

        if (room.gameState.werewolfKillTarget) {
            const targetPlayer = room.players.find(p => p.id === room.gameState.werewolfKillTarget.id);

            if (targetPlayer && room.gameState.doctorProtectTarget && targetPlayer.id === room.gameState.doctorProtectTarget.id) {
                addSystemMessage(roomCode, `Malam ini ${targetPlayer.name} diserang Werewolf tapi diselamatkan oleh Dokter.`);
            } else if (targetPlayer) {
                killedPlayer = targetPlayer;
                killedPlayer.isAlive = false;
                room.gameState.deadPlayersQueue.push(killedPlayer);
            }
        }

        checkGameEnd(roomCode);
        if (room.gameState.phase === 'night') { // If game not over
            setTimeout(() => {
                const currentRoom = rooms[roomCode];
                if (!currentRoom || currentRoom.gameState.phase === 'gameOver') {
                    console.log(`[DEBUG] Skipping day phase start for room ${roomCode}: Room not found or game is over.`);
                    return;
                }
                try { // try-catch di dalam timeout
                    startDayPhase(roomCode);
                } catch (timeoutError) {
                    console.error(`[ERROR] Timeout callback for resolveNightActions in room ${roomCode} failed:`, timeoutError);
                }
            }, 3000);
        }
    } catch (error) {
        console.error(`[ERROR] resolveNightActions for room ${roomCode} failed:`, error);
        addSystemMessage(roomCode, `Terjadi kesalahan internal saat menyelesaikan aksi malam hari.`);
    }
}

function checkGameEnd(roomCode) {
    try {
        const room = rooms[roomCode];
        if (!room) return;

        const aliveWerewolves = room.players.filter(p => p.isAlive && p.role === 'Werewolf');
        const aliveVillagers = room.players.filter(p => p.isAlive && p.role !== 'Werewolf'); // Villagers include Doctor, Seer

        if (aliveWerewolves.length === 0) {
            io.to(roomCode).emit('gameOver', 'Selamat! Penduduk desa memenangkan permainan!');
            addSystemMessage(roomCode, 'Penduduk desa menang!');
            room.gameState.phase = 'gameOver';
        } else if (aliveWerewolves.length >= aliveVillagers.length) {
            io.to(roomCode).emit('gameOver', 'Maaf! Werewolf memenangkan permainan!');
            addSystemMessage(roomCode, 'Werewolf menang!');
            room.gameState.phase = 'gameOver';
        } else if (room.players.filter(p => p.isAlive).length <= 2) { // Too few players to continue
            io.to(roomCode).emit('gameOver', 'Permainan berakhir karena jumlah pemain terlalu sedikit untuk melanjutkan!');
            addSystemMessage(roomCode, 'Permainan berakhir karena terlalu sedikit pemain.');
            room.gameState.phase = 'gameOver';
        }
    } catch (error) {
        console.error(`[ERROR] checkGameEnd for room ${roomCode} failed:`, error);
        addSystemMessage(roomCode, `Terjadi kesalahan internal saat memeriksa akhir game.`);
    }
}

// Helper to add system messages to chat
function addSystemMessage(roomCode, message) {
    if (!rooms[roomCode]) {
        console.log(`[DEBUG] Tidak dapat mengirim pesan sistem ke room ${roomCode}: Room tidak ditemukan.`);
        return;
    }
    io.to(roomCode).emit('newChatMessage', `<span style="color: #666;">[Sistem]</span> ${message}`);
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- Room Management ---
    socket.on('createRoom', () => {
        try {
            const roomCode = generateRoomCode();
            rooms[roomCode] = {
                hostSocketId: socket.id,
                players: [], // { id, name, type, role, isAlive, socketId }
                gameState: {} // Game specific state
            };
            socket.join(roomCode);
            socket.emit('roomCreated', roomCode);
            console.log(`Room created: ${roomCode} by ${socket.id}`);
            addSystemMessage(roomCode, `Ruangan ${roomCode} dibuat oleh host.`);
            io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode)); // Send initial player list
        } catch (error) {
            console.error(`[ERROR] createRoom failed for socket ${socket.id}:`, error);
            socket.emit('actionError', 'Gagal membuat ruangan.');
        }
    });

    socket.on('joinRoom', (roomCode) => {
        try {
            if (rooms[roomCode]) {
                socket.join(roomCode);
                socket.emit('joinedRoom', roomCode);
                console.log(`${socket.id} joined room: ${roomCode}`);
                io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
                addSystemMessage(roomCode, `${socket.id.substring(0, 4)}... bergabung ke ruangan.`);
            } else {
                socket.emit('roomNotFound');
                console.log(`${socket.id} tried to join non-existent room: ${roomCode}`);
            }
        } catch (error) {
            console.error(`[ERROR] joinRoom for room ${roomCode} by socket ${socket.id} failed:`, error);
            socket.emit('actionError', 'Gagal bergabung ke ruangan.');
        }
    });

    // --- Player Setup ---
    socket.on('playerSetup', ({ roomCode, playerName, playerType }) => {
        try {
            const room = rooms[roomCode];
            if (!room) {
                socket.emit('actionError', 'Ruangan tidak ditemukan.');
                return;
            }

            let player = room.players.find(p => p.socketId === socket.id);

            if (player) {
                player.name = playerName;
                player.type = playerType;
                addSystemMessage(roomCode, `Pemain ${playerName} (${playerType}) telah memperbarui pendaftaran.`);
            } else {
                const newPlayerId = room.players.length > 0 ? Math.max(...room.players.map(p => p.id)) + 1 : 0;
                player = {
                    id: newPlayerId,
                    name: playerName,
                    type: playerType,
                    role: null,
                    isAlive: true,
                    socketId: socket.id,
                    hasVoted: false,
                    actionChosen: false,
                    voteTarget: null
                };
                room.players.push(player);
                addSystemMessage(roomCode, `Pemain ${playerName} (${playerType}) telah terdaftar.`);
            }
            socket.emit('playerRegistered', player.id);
            io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
        } catch (error) {
            console.error(`[ERROR] playerSetup for room ${roomCode} by socket ${socket.id} failed:`, error);
            socket.emit('actionError', 'Gagal mendaftar pemain.');
        }
    });

    // Host adds computer players or human placeholders
    socket.on('addPlayerToRoom', ({ roomCode, playerName, playerType }) => {
        try {
            const room = rooms[roomCode];
            if (!room || room.hostSocketId !== socket.id) {
                socket.emit('actionError', 'Anda bukan host atau ruangan tidak ditemukan.');
                return;
            }
            const newPlayerId = room.players.length > 0 ? Math.max(...room.players.map(p => p.id)) + 1 : 0;
            const player = {
                id: newPlayerId,
                name: playerName,
                type: playerType,
                role: null,
                isAlive: true,
                socketId: null,
                hasVoted: false,
                actionChosen: false,
                voteTarget: null
            };
            room.players.push(player);
            addSystemMessage(roomCode, `Host menambahkan ${playerName} (${playerType}).`);
            io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
        } catch (error) {
            console.error(`[ERROR] addPlayerToRoom for room ${roomCode} by socket ${socket.id} failed:`, error);
            socket.emit('actionError', 'Gagal menambahkan pemain.');
        }
    });


    // --- Game Start ---
    socket.on('startGame', (roomCode) => {
        try {
            const room = rooms[roomCode];
            if (!room) {
                socket.emit('actionError', 'Ruangan tidak ditemukan.');
                return;
            }

            if (room.hostSocketId !== socket.id) {
                socket.emit('actionError', 'Hanya host yang bisa memulai game.');
                return;
            }

            const humanPlayersCount = room.players.filter(p => p.type === 'human' && p.socketId !== null).length;

            if (room.players.length < 3) {
                socket.emit('actionError', 'Minimal 3 pemain diperlukan untuk memulai game.');
                return;
            }

            if (humanPlayersCount < 1) {
                socket.emit('actionError', 'Minimal 1 pemain manusia yang terhubung diperlukan untuk memulai game.');
                return;
            }

            console.log(`Starting game in room ${roomCode}`);
            startGame(roomCode);
        } catch (error) {
            console.error(`[ERROR] startGame event for room ${roomCode} failed:`, error);
            socket.emit('actionError', 'Gagal memulai game.');
        }
    });

    // --- In-Game Actions ---
    socket.on('submitVote', ({ roomCode, voterId, targetId }) => {
        try {
            const room = rooms[roomCode];
            if (!room || room.gameState.phase !== 'day') {
                socket.emit('actionError', 'Tidak bisa voting saat ini.');
                return;
            }

            const voter = room.players.find(p => p.id === voterId && p.isAlive);
            const target = room.players.find(p => p.id === targetId && p.isAlive);

            if (!voter || !target || voter.hasVoted) {
                socket.emit('actionError', 'Anda tidak bisa voting.');
                return;
            }

            voter.hasVoted = true;
            voter.voteTarget = targetId;
            if (room.gameState.votes[targetId]) {
                room.gameState.votes[targetId]++;
            } else {
                room.gameState.votes[targetId] = 1;
            }

            io.to(socket.id).emit('actionSubmitted');
            addSystemMessage(roomCode, `${voter.name} telah memberikan suaranya.`);

            const allHumanVoted = room.players.filter(p => p.isAlive && p.type === 'human').every(p => p.hasVoted);
            if (allHumanVoted) {
                setTimeout(() => {
                    const currentRoom = rooms[roomCode];
                    if (!currentRoom || currentRoom.gameState.phase !== 'day') {
                        console.log(`[DEBUG] Skipping submitVote resolution for room ${roomCode}: Room not found or phase changed.`);
                        return;
                    }
                    try { // try-catch di dalam timeout
                        processComputerVotes(roomCode);
                        resolveDayVote(roomCode);
                    } catch (timeoutError) {
                        console.error(`[ERROR] Timeout callback for submitVote in room ${roomCode} failed:`, timeoutError);
                    }
                }, 1000);
            }
        } catch (error) {
            console.error(`[ERROR] submitVote for room ${roomCode} by socket ${socket.id} failed:`, error);
            socket.emit('actionError', 'Terjadi kesalahan saat submit vote.');
        }
    });

    socket.on('submitWerewolfKill', ({ roomCode, voterId, targetId }) => {
        try {
            const room = rooms[roomCode];
            if (!room || room.gameState.phase !== 'night') {
                socket.emit('actionError', 'Tidak bisa menyerang saat ini.');
                return;
            }

            const werewolf = room.players.find(p => p.id === voterId && p.isAlive && p.role === 'Werewolf');
            const target = room.players.find(p => p.id === targetId && p.isAlive && p.role !== 'Werewolf');

            if (!werewolf || !target || werewolf.actionChosen) {
                socket.emit('actionError', 'Anda tidak bisa melakukan aksi ini.');
                return;
            }

            werewolf.actionChosen = true;
            room.gameState.werewolfKillTarget = target;
            io.to(socket.id).emit('actionSubmitted');
            addSystemMessage(roomCode, `${werewolf.name} telah memilih mangsa.`);

            const allHumanSpecialRolesActed = room.players.filter(p => p.isAlive && p.type === 'human' && ['Werewolf', 'Doctor', 'Seer'].includes(p.role))
                .every(p => p.actionChosen);
            if (allHumanSpecialRolesActed) {
                setTimeout(() => {
                    const currentRoom = rooms[roomCode];
                    if (!currentRoom || currentRoom.gameState.phase !== 'night') {
                        console.log(`[DEBUG] Skipping night action resolution for room ${roomCode}: Room not found or phase changed.`);
                        return;
                    }
                    try { // try-catch di dalam timeout
                        processComputerNightActions(roomCode);
                        resolveNightActions(roomCode);
                    } catch (timeoutError) {
                        console.error(`[ERROR] Timeout callback for submitWerewolfKill in room ${roomCode} failed:`, timeoutError);
                    }
                }, 1000);
            }
        } catch (error) {
            console.error(`[ERROR] submitWerewolfKill for room ${roomCode} by socket ${socket.id} failed:`, error);
            socket.emit('actionError', 'Terjadi kesalahan saat submit serangan werewolf.');
        }
    });

    socket.on('submitDoctorProtect', ({ roomCode, voterId, targetId }) => {
        try {
            const room = rooms[roomCode];
            if (!room || room.gameState.phase !== 'night') {
                socket.emit('actionError', 'Tidak bisa melindungi saat ini.');
                return;
            }

            const doctor = room.players.find(p => p.id === voterId && p.isAlive && p.role === 'Doctor');
            const target = room.players.find(p => p.id === targetId && p.isAlive);

            if (!doctor || !target || doctor.actionChosen) {
                socket.emit('actionError', 'Anda tidak bisa melakukan aksi ini.');
                return;
            }

            doctor.actionChosen = true;
            room.gameState.doctorProtectTarget = target;
            io.to(socket.id).emit('actionSubmitted');
            addSystemMessage(roomCode, `${doctor.name} telah memilih untuk melindungi.`);

            const allHumanSpecialRolesActed = room.players.filter(p => p.isAlive && p.type === 'human' && ['Werewolf', 'Doctor', 'Seer'].includes(p.role))
                .every(p => p.actionChosen);
            if (allHumanSpecialRolesActed) {
                setTimeout(() => {
                    const currentRoom = rooms[roomCode];
                    if (!currentRoom || currentRoom.gameState.phase !== 'night') {
                        console.log(`[DEBUG] Skipping night action resolution for room ${roomCode}: Room not found or phase changed.`);
                        return;
                    }
                    try { // try-catch di dalam timeout
                        processComputerNightActions(roomCode);
                        resolveNightActions(roomCode);
                    } catch (timeoutError) {
                        console.error(`[ERROR] Timeout callback for submitDoctorProtect in room ${roomCode} failed:`, timeoutError);
                    }
                }, 1000);
            }
        } catch (error) {
            console.error(`[ERROR] submitDoctorProtect for room ${roomCode} by socket ${socket.id} failed:`, error);
            socket.emit('actionError', 'Terjadi kesalahan saat submit perlindungan dokter.');
        }
    });

    socket.on('submitSeerReveal', ({ roomCode, voterId, targetId }) => {
        try {
            const room = rooms[roomCode];
            if (!room || room.gameState.phase !== 'night') {
                socket.emit('actionError', 'Tidak bisa melihat peran saat ini.');
                return;
            }

            const seer = room.players.find(p => p.id === voterId && p.isAlive && p.role === 'Seer');
            const target = room.players.find(p => p.id === targetId && p.isAlive);

            if (!seer || !target || seer.actionChosen) {
                socket.emit('actionError', 'Anda tidak bisa melakukan aksi ini.');
                return;
            }

            seer.actionChosen = true;
            io.to(socket.id).emit('actionSubmitted');
            io.to(socket.id).emit('newChatMessage', `<span style="color: #666;">[Sistem]</span> Peran **${target.name}** adalah **${target.role}**.`);
            addSystemMessage(roomCode, `${seer.name} telah melihat peran seseorang.`);

            const allHumanSpecialRolesActed = room.players.filter(p => p.isAlive && p.type === 'human' && ['Werewolf', 'Doctor', 'Seer'].includes(p.role))
                .every(p => p.actionChosen);
            if (allHumanSpecialRolesActed) {
                setTimeout(() => {
                    const currentRoom = rooms[roomCode];
                    if (!currentRoom || currentRoom.gameState.phase !== 'night') {
                        console.log(`[DEBUG] Skipping night action resolution for room ${roomCode}: Room not found or phase changed.`);
                        return;
                    }
                    try { // try-catch di dalam timeout
                        processComputerNightActions(roomCode);
                        resolveNightActions(roomCode);
                    } catch (timeoutError) {
                        console.error(`[ERROR] Timeout callback for submitSeerReveal in room ${roomCode} failed:`, timeoutError);
                    }
                }, 1000);
            }
        } catch (error) {
            console.error(`[ERROR] submitSeerReveal for room ${roomCode} by socket ${socket.id} failed:`, error);
            socket.emit('actionError', 'Terjadi kesalahan saat submit reveal Seer.');
        }
    });

    // --- Chat ---
    socket.on('chatMessage', ({ roomCode, senderId, message }) => {
        try {
            const room = rooms[roomCode];
            if (!room) {
                console.log(`[DEBUG] Tidak dapat mengirim pesan chat ke room ${roomCode}: Room tidak ditemukan.`);
                return;
            }

            const sender = room.players.find(p => p.id === senderId);
            if (sender) {
                const isWerewolfChat = sender.role === 'Werewolf' && room.gameState.phase === 'night';

                if (isWerewolfChat) {
                    const werewolfSockets = room.players
                        .filter(p => p.role === 'Werewolf' && p.isAlive && p.socketId)
                        .map(p => p.socketId);
                    werewolfSockets.forEach(sId => {
                        io.to(sId).emit('newChatMessage', `<strong>${sender.name} (Werewolf):</strong> ${message}`);
                    });
                } else {
                    io.to(roomCode).emit('newChatMessage', `<strong>${sender.name}:</strong> ${message}`);
                }
            }
        } catch (error) {
            console.error(`[ERROR] chatMessage for room ${roomCode} from socket ${socket.id} failed:`, error);
        }
    });

    // --- Disconnection ---
    socket.on('disconnect', () => {
        try {
            console.log(`User  disconnected: ${socket.id}`);
            for (const roomCode in rooms) {
                const room = rooms[roomCode];
                if (!room) continue;

                const initialPlayerCount = room.players.length;
                room.players = room.players.filter(p => p.socketId !== socket.id);

                if (room.hostSocketId === socket.id) {
                    // Jika host terputus saat game belum selesai, anggap sebagai disconnect tidak sengaja
                    // Jika game sudah 'gameOver', berarti disconnect adalah bagian dari proses restart/keluar
                    if (room.gameState.phase !== 'gameOver') {
                        addSystemMessage(roomCode, 'Host terputus secara tak terduga. Ruangan ini akan ditutup.');
                        io.to(roomCode).emit('gameOver', 'Host terputus. Permainan berakhir.');
                        delete rooms[roomCode];
                        console.log(`Room ${roomCode} deleted due to host unexpected disconnect.`);
                    } else {
                        // Jika game sudah berakhir dan host terputus (misal karena klik restart/refresh),
                        // biarkan dia putus dan ruangan mungkin sudah dihapus oleh event 'restartGame'
                        console.log(`Host ${socket.id} terputus setelah game over atau restart.`);
                        // Opsional: Cek apakah ruangan masih ada dan hapus jika tidak sengaja belum dihapus oleh 'restartGame'
                        if (rooms[roomCode]) {
                            delete rooms[roomCode];
                            console.log(`Room ${roomCode} cleaned up after host disconnect in game over state.`);
                        }
                    }
                }

                if (room.players.length < initialPlayerCount) {
                    // Pemain meninggalkan ruangan
                    console.log(`Player ${socket.id} left room ${roomCode}.`);
                    io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
                    addSystemMessage(roomCode, `${socket.id.substring(0, 4)}... meninggalkan ruangan.`);
                    checkGameEnd(roomCode);
                    break;
                }
            }
        } catch (error) {
            console.error(`[ERROR] Disconnect handler for socket ${socket.id} failed:`, error);
        }
    });

    // --- Restart Game ---
    socket.on('restartGame', (roomCode) => {
        try {
            const room = rooms[roomCode];
            if (!room || room.hostSocketId !== socket.id) {
                socket.emit('actionError', 'Hanya host yang bisa memulai ulang game.');
                return;
            }

            // Informasikan semua klien di ruangan bahwa game akan direstart/ditutup
            io.to(roomCode).emit('gameOver', 'Host telah memulai ulang game. Menghubungkan kembali...');

            // Hapus ruangan dari daftar aktif
            delete rooms[roomCode];
            console.log(`Room ${roomCode} deleted for restart.`);

            // Tidak perlu mengirim 'gameRestarted' ke klien yang sama
            // Klien akan me-reload halaman setelah menerima 'gameOver' atau secara manual me-reload dari sisi klien
            // io.to(socket.id).emit('gameRestarted', 'Game telah dimulai ulang.');
        } catch (error) {
            console.error(`[ERROR] restartGame for room ${roomCode} failed:`, error);
            socket.emit('actionError', 'Gagal memulai ulang game.');
        }
    });


});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Serving static files from: ${path.join(__dirname, 'public')}`);
});
