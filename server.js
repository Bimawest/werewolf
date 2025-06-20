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
        console.warn(`Attempted to assign roles for ${numPlayers} players in room ${roomCode}. Min 3 required.`);
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
}

function startDayPhase(roomCode) {
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

        // Handle computer player votes for day phase
        setTimeout(() => {
            processComputerVotes(roomCode);
            resolveDayVote(roomCode);
        }, 10000); // Give 10 seconds for human players to vote, then computers vote
    }
}

function processComputerVotes(roomCode) {
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
}

function resolveDayVote(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    let maxVotes = 0;
    let playersToHang = [];

    const allHumanVoted = room.players.filter(p => p.isAlive && p.type === 'human').every(p => p.hasVoted);

    if (!allHumanVoted) {
        addSystemMessage(roomCode, 'Tidak semua pemain manusia selesai voting. Menunggu...');
        // Set a timeout to re-check or force resolution after a longer period if needed
        return;
    }

    if (Object.keys(room.gameState.votes).length === 0) {
        addSystemMessage(roomCode, 'Tidak ada yang digantung hari ini karena tidak ada suara.');
        setTimeout(() => startNightPhase(roomCode), 3000);
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
        setTimeout(() => startNightPhase(roomCode), 3000);
    }
}

function startNightPhase(roomCode) {
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

    // Process computer actions after a short delay to allow human players to act
    setTimeout(() => {
        processComputerNightActions(roomCode);
        resolveNightActions(roomCode);
    }, 5000); // Give 5 seconds for human players to make night actions
}

function processComputerNightActions(roomCode) {
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

}

function resolveNightActions(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    let killedPlayer = null;

    if (room.gameState.werewolfKillTarget) {
        // Find the actual player object in the room's player list
        const targetPlayer = room.players.find(p => p.id === room.gameState.werewolfKillTarget.id);

        if (targetPlayer && room.gameState.doctorProtectTarget && targetPlayer.id === room.gameState.doctorProtectTarget.id) {
            addSystemMessage(roomCode, `Malam ini ${targetPlayer.name} diserang Werewolf tapi diselamatkan oleh Dokter.`);
        } else if (targetPlayer) {
            killedPlayer = targetPlayer;
            killedPlayer.isAlive = false;
            room.gameState.deadPlayersQueue.push(killedPlayer); // Add to queue for day announcement
        }
    }

    checkGameEnd(roomCode);
    if (room.gameState.phase === 'night') { // If game not over
        setTimeout(() => startDayPhase(roomCode), 3000);
    }
}

function checkGameEnd(roomCode) {
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
}

// Helper to add system messages to chat
function addSystemMessage(roomCode, message) {
    io.to(roomCode).emit('newChatMessage', `<span style="color: #666;">[Sistem]</span> ${message}`);
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- Room Management ---
    socket.on('createRoom', () => {
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
    });

    socket.on('joinRoom', (roomCode) => {
        if (rooms[roomCode]) {
            socket.join(roomCode);
            socket.emit('joinedRoom', roomCode);
            console.log(`${socket.id} joined room: ${roomCode}`);
            // Update player list for all in room (even before player registers)
            io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
            addSystemMessage(roomCode, `${socket.id.substring(0,4)}... bergabung ke ruangan.`);
        } else {
            socket.emit('roomNotFound');
            console.log(`${socket.id} tried to join non-existent room: ${roomCode}`);
        }
    });

    // --- Player Setup ---
    socket.on('playerSetup', ({ roomCode, playerName, playerType }) => {
        const room = rooms[roomCode];
        if (!room) {
            socket.emit('actionError', 'Ruangan tidak ditemukan.');
            return;
        }

        // Check if a player with this socket ID already exists in the room
        let player = room.players.find(p => p.socketId === socket.id);

        if (player) {
            // Update existing player
            player.name = playerName;
            player.type = playerType;
            addSystemMessage(roomCode, `Pemain ${playerName} (${playerType}) telah memperbarui pendaftaran.`);
        } else {
            // Create new player
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
                voteTarget: null // Store vote target during day phase
            };
            room.players.push(player);
            addSystemMessage(roomCode, `Pemain ${playerName} (${playerType}) telah terdaftar.`);
        }
        socket.emit('playerRegistered', player.id); // Confirm registration to the client
        io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
    });

    // Host adds computer players or human placeholders
    socket.on('addPlayerToRoom', ({ roomCode, playerName, playerType }) => {
        const room = rooms[roomCode];
        if (!room || room.hostSocketId !== socket.id) {
            socket.emit('actionError', 'Anda bukan host atau ruangan tidak ditemukan.');
            return;
        }
        const newPlayerId = room.players.length > 0 ? Math.max(...room.players.map(p => p.id)) + 1 : 0;
        const player = {
            id: newPlayerId,
            name: playerName,
            type: playerType, // Could be 'computer' or 'human' placeholder
            role: null,
            isAlive: true,
            socketId: null, // No socket for computer or placeholder human
            hasVoted: false,
            actionChosen: false,
            voteTarget: null
        };
        room.players.push(player);
        addSystemMessage(roomCode, `Host menambahkan ${playerName} (${playerType}).`);
        io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
    });


    // --- Game Start ---
    socket.on('startGame', (roomCode) => {
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
    });

    // --- In-Game Actions ---
    socket.on('submitVote', ({ roomCode, voterId, targetId }) => {
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
        voter.voteTarget = targetId; // Store individual vote
        if (room.gameState.votes[targetId]) {
            room.gameState.votes[targetId]++;
        } else {
            room.gameState.votes[targetId] = 1;
        }

        io.to(socket.id).emit('actionSubmitted');
        addSystemMessage(roomCode, `${voter.name} telah memberikan suaranya.`);

        // Check if all active human players have voted
        const allHumanVoted = room.players.filter(p => p.isAlive && p.type === 'human').every(p => p.hasVoted);
        if (allHumanVoted) {
            // Give a moment for last vote to register, then process computer votes and resolve
            setTimeout(() => {
                processComputerVotes(roomCode);
                resolveDayVote(roomCode);
            }, 1000);
        }
    });

    socket.on('submitWerewolfKill', ({ roomCode, voterId, targetId }) => {
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
        room.gameState.werewolfKillTarget = target; // Only one werewolf kill target for the night
        io.to(socket.id).emit('actionSubmitted');
        addSystemMessage(roomCode, `${werewolf.name} telah memilih mangsa.`);

        // Check if all active human special roles have acted
        // This could be made more robust to check for all werewolves, doctors, seers
        const allHumanSpecialRolesActed = room.players.filter(p => p.isAlive && p.type === 'human' && ['Werewolf', 'Doctor', 'Seer'].includes(p.role))
            .every(p => p.actionChosen);
        if (allHumanSpecialRolesActed) {
             setTimeout(() => {
                processComputerNightActions(roomCode); // Ensure computer actions are processed
                resolveNightActions(roomCode);
            }, 1000);
        }
    });

    socket.on('submitDoctorProtect', ({ roomCode, voterId, targetId }) => {
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
                processComputerNightActions(roomCode);
                resolveNightActions(roomCode);
            }, 1000);
        }
    });

    socket.on('submitSeerReveal', ({ roomCode, voterId, targetId }) => {
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
                processComputerNightActions(roomCode);
                resolveNightActions(roomCode);
            }, 1000);
        }
    });

    // --- Chat ---
    socket.on('chatMessage', ({ roomCode, senderId, message }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const sender = room.players.find(p => p.id === senderId);
        if (sender) {
            // Check if sender is a Werewolf and it's night time
            const isWerewolfChat = sender.role === 'Werewolf' && room.gameState.phase === 'night';

            // If it's werewolf chat, send only to other werewolves
            if (isWerewolfChat) {
                const werewolfSockets = room.players
                    .filter(p => p.role === 'Werewolf' && p.isAlive && p.socketId)
                    .map(p => p.socketId);
                werewolfSockets.forEach(sId => {
                    io.to(sId).emit('newChatMessage', `<strong>${sender.name} (Werewolf):</strong> ${message}`);
                });
            } else {
                // Otherwise, send to everyone in the room
                io.to(roomCode).emit('newChatMessage', `<strong>${sender.name}:</strong> ${message}`);
            }
        }
    });

    // --- Disconnection ---
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            // Remove player from the room
            const initialPlayerCount = room.players.length;
            room.players = room.players.filter(p => p.socketId !== socket.id);

            if (room.players.length < initialPlayerCount) {
                // A player left the room
                console.log(`Player ${socket.id} left room ${roomCode}.`);
                io.to(roomCode).emit('updatePlayerList', getPublicPlayers(roomCode));
                addSystemMessage(roomCode, `${socket.id.substring(0,4)}... meninggalkan ruangan.`);

                // If host disconnects, delete room
                if (room.hostSocketId === socket.id) {
                    addSystemMessage(roomCode, 'Host terputus. Ruangan ini akan ditutup.');
                    io.to(roomCode).emit('gameOver', 'Host terputus. Permainan berakhir.');
                    delete rooms[roomCode];
                    console.log(`Room ${roomCode} deleted due to host disconnect.`);
                }
                 // Check if game needs to end due to player count if game is active
                if (room.gameState.phase && room.gameState.phase !== 'gameOver') {
                    checkGameEnd(roomCode);
                }
                break; // A socket can only be in one room at a time for this simple structure
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Serving static files from: ${path.join(__dirname, 'public')}`);
});
