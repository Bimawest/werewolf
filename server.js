// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Game State (di Server) ---
let rooms = {}; // Struktur untuk menyimpan game state per ruangan

io.on('connection', (socket) => {
    console.log('Pengguna terhubung:', socket.id);

    // --- Lobby & Room Management ---
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            players: [], // { id, name, type, role, isAlive, socketId, hasVoted, actionChosen }
            gamePhase: 'setup',
            chatMessages: [],
            votes: {},
            werewolfKillTarget: null,
            doctorProtectTarget: null,
            hostSocketId: socket.id // Store the host's socket ID
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log(`Ruangan baru dibuat: ${roomCode} oleh ${socket.id}`);
    });

    socket.on('joinRoom', (roomCode) => {
        if (rooms[roomCode] && rooms[roomCode].gamePhase === 'setup') {
            // Check if player already registered in this room with THIS socket.id
            const existingPlayerBySocket = rooms[roomCode].players.find(p => p.socketId === socket.id);
            if (existingPlayerBySocket) {
                 socket.emit('actionError', 'Anda sudah terdaftar di ruangan ini dengan koneksi ini.');
                 socket.emit('playerRegistered', existingPlayerBySocket.id); // Re-confirm player registration
                 io.to(roomCode).emit('updatePlayerList', rooms[roomCode].players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, type: p.type, socketId: p.socketId })));
                 return;
            }

            // If it's a new human connecting, try to assign them to a 'human' placeholder if any
            let assignedToPlaceholder = false;
            // For now, we will just add them as a new human player.
            // If you implement "human placeholder", this logic would find a null socketId 'human' player
            // and assign this socket.id to it.

            socket.join(roomCode);
            socket.emit('joinedRoom', roomCode);
            console.log(`${socket.id} bergabung ke ruangan: ${roomCode}`);
            io.to(roomCode).emit('updatePlayerList', rooms[roomCode].players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, type: p.type, socketId: p.socketId })));
            addChatMessage(roomCode, `Seorang pemain baru telah bergabung.`);
        } else {
            socket.emit('roomNotFound');
            console.log(`${socket.id} mencoba bergabung ke ruangan tidak ada atau game sudah berjalan: ${roomCode}`);
        }
    });

    // --- Game Logic (Di Server) ---

    socket.on('playerSetup', (data) => {
        const { roomCode, playerName, playerType } = data;
        const room = rooms[roomCode];
        if (room && room.gamePhase === 'setup') {
            const existingPlayer = room.players.find(p => p.socketId === socket.id);
            if (existingPlayer) {
                socket.emit('actionError', 'Anda sudah terdaftar di ruangan ini.');
                return;
            }

            const newPlayer = {
                id: room.players.length, // Assign a unique ID
                name: playerName,
                type: playerType, // This player's type as chosen by themselves
                socketId: socket.id, // This is a real player connected via this socket
                role: null,
                isAlive: true,
                hasVoted: false,
                actionChosen: false
            };
            room.players.push(newPlayer);
            socket.emit('playerRegistered', newPlayer.id); // Konfirmasi ke pemain yang baru daftar
            io.to(roomCode).emit('updatePlayerList', room.players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, type: p.type, socketId: p.socketId })));
            addChatMessage(roomCode, `${playerName} (${playerType}) telah bergabung.`);
        } else {
            socket.emit('actionError', 'Tidak bisa mendaftar pemain saat ini.');
        }
    });

    // Handle adding players via the "Add Seat" button (by host)
    socket.on('addPlayerToRoom', (data) => {
        const { roomCode, playerName, playerType } = data;
        const room = rooms[roomCode];

        // Ensure only the host can add players and game is in setup phase
        if (room && room.hostSocketId === socket.id && room.gamePhase === 'setup') {
            const newPlayer = {
                id: room.players.length, // Assign a unique ID
                name: playerName,
                type: playerType, // Can be 'human' (as placeholder) or 'computer'
                socketId: null, // No actual socket connected to this player
                role: null,
                isAlive: true,
                hasVoted: false,
                actionChosen: false
            };
            room.players.push(newPlayer);
            io.to(roomCode).emit('updatePlayerList', room.players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, type: p.type, socketId: p.socketId })));
            addChatMessage(roomCode, `${playerName} (${playerType} - Ditambahkan) telah ditambahkan ke ruangan.`);
            console.log(`[${roomCode}] ${playerName} (${playerType}) added by host.`);
        } else {
            socket.emit('actionError', 'Anda tidak memiliki izin untuk menambahkan pemain atau game sudah dimulai.');
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        // Check if the request comes from the host
        if (room && room.hostSocketId === socket.id && room.gamePhase === 'setup') {
            const connectedHumanPlayersCount = room.players.filter(p => p.type === 'human' && p.socketId !== null && p.isAlive).length;
            
            if (room.players.length >= 3 && connectedHumanPlayersCount >= 1) { // Min 3 total players, min 1 real human connected
                assignRoles(room);
                room.gamePhase = 'day';
                addChatMessage(roomCode, 'Game dimulai! Selamat datang di desa Werewolf.');
                
                room.players.forEach(p => {
                    if (p.socketId) { // Only send role to players with active sockets
                        io.to(p.socketId).emit('yourRole', p.role);
                        if (p.role === 'Werewolf') {
                            const otherWerewolves = room.players.filter(ow => ow.isAlive && ow.id !== p.id && ow.role === 'Werewolf');
                            if (otherWerewolves.length > 0) {
                                io.to(p.socketId).emit('werewolfBuddies', otherWerewolves.map(ow => ow.name));
                            }
                        }
                    }
                });

                io.to(roomCode).emit('gameStarted');
                io.to(roomCode).emit('updatePlayerList', room.players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, type: p.type, socketId: p.socketId })));
                startDayPhase(roomCode);
            } else {
                socket.emit('gameStartError', `Minimal 3 pemain total dan setidaknya 1 pemain manusia yang terhubung (saat ini: ${connectedHumanPlayersCount}).`);
            }
        } else {
            socket.emit('gameStartError', 'Anda tidak memiliki izin untuk memulai game atau game sudah berjalan.');
        }
    });

    socket.on('chatMessage', (data) => {
        const { roomCode, senderId, message } = data;
        const room = rooms[roomCode];
        if (room) {
            const sender = room.players.find(p => p.id === senderId);
            addChatMessage(roomCode, `<strong>${sender ? sender.name : 'Unknown'}:</strong> ${message}`, false);
        }
    });

    socket.on('disconnect', () => {
        console.log('Pengguna terputus:', socket.id);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const player = room.players.find(p => p.socketId === socket.id);
            if (player) {
                // For a real player, just remove their socketId, don't remove them from the game entirely
                // If they are a placeholder, they won't have a socketId anyway
                player.socketId = null; // Mark as disconnected
                addChatMessage(roomCode, `${player.name} telah meninggalkan permainan.`);
                io.to(roomCode).emit('updatePlayerList', room.players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, type: p.type, socketId: p.socketId })));
                
                // If the host disconnects, the room might become unmanageable
                if (room.hostSocketId === socket.id) {
                    addChatMessage(roomCode, `Host telah terputus. Game mungkin tidak dapat dilanjutkan atau dimulai.`);
                    // Optionally, assign new host or delete room if empty
                    // For simplicity, we just log this.
                }

                // If no real human players are left, maybe end the game or put on hold
                const remainingConnectedHumans = room.players.filter(p => p.isAlive && p.type === 'human' && p.socketId !== null).length;
                if (room.gamePhase !== 'gameOver' && remainingConnectedHumans === 0 && room.players.filter(p => p.isAlive).length > 0) {
                     addChatMessage(roomCode, `Semua pemain manusia telah terputus. Permainan dilanjutkan dengan pemain Komputer (jika ada).`);
                     // Optionally, automatically transition to computer-only game logic
                }
                
                // Clean up empty rooms after some delay if no players left (real or placeholder)
                // This is a simple cleanup; more complex logic might wait if game is active
                if (room.players.every(p => p.socketId === null) && room.gamePhase === 'setup') {
                    delete rooms[roomCode];
                    console.log(`Room ${roomCode} deleted as all players disconnected in setup.`);
                }
                
                checkGameEnd(roomCode); // Check if game state changes due to disconnection
                break;
            }
        }
    });

    // --- Game Logic Functions (called by Socket.IO events or internally) ---

    function assignRoles(room) {
        const numPlayers = room.players.length;
        let availableRoles = [];
        
        if (numPlayers >= 3 && numPlayers <= 5) {
            availableRoles.push('Werewolf', 'Villager', 'Villager');
            if (numPlayers >= 4) availableRoles.push('Doctor');
            if (numPlayers === 5) availableRoles.push('Seer');
        } else if (numPlayers >= 6 && numPlayers <= 10) {
            availableRoles.push('Werewolf', 'Werewolf', 'Villager', 'Villager', 'Villager', 'Doctor', 'Seer');
            if (numPlayers >= 8) availableRoles.push('Villager');
            if (numPlayers >= 9) availableRoles.push('Werewolf');
            if (numPlayers === 10) availableRoles.push('Villager');
        } else {
            let numWerewolves = Math.floor(numPlayers / 4);
            if (numWerewolves < 2) numWerewolves = 2;
            for (let i = 0; i < numWerewolves; i++) availableRoles.push('Werewolf');
            availableRoles.push('Doctor', 'Seer');
            while (availableRoles.length < numPlayers) {
                availableRoles.push('Villager');
            }
        }

        availableRoles.sort(() => Math.random() - 0.5);
        room.players.forEach((player, index) => {
            player.role = availableRoles[index];
            console.log(`[${room.roomCode}] ${player.name} is ${player.role}`);
        });
    }

    function addChatMessage(roomCode, message, isSystem = true) {
        const room = rooms[roomCode];
        if (room) {
            const formattedMessage = isSystem ? `<span style="color: #666;">[Sistem]</span> ${message}` : message;
            room.chatMessages.push(formattedMessage);
            io.to(roomCode).emit('newChatMessage', formattedMessage);
        }
    }

    function startDayPhase(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.gamePhase === 'gameOver') return;
        room.gamePhase = 'day';
        room.votes = {}; // Reset votes
        room.players.forEach(p => {
            p.hasVoted = false;
            p.actionChosen = false;
        });
        io.to(roomCode).emit('updateGamePhase', 'Siang Hari (Diskusi & Voting)');
        addChatMessage(roomCode, 'Ini adalah siang hari. Diskusikan siapa yang mencurigakan.');
        addChatMessage(roomCode, 'Waktunya voting. Pilih siapa yang ingin digantung!');
        
        // Request vote from all alive human players with active sockets
        const activeHumanPlayers = room.players.filter(p => p.isAlive && p.type === 'human' && p.socketId !== null);
        activeHumanPlayers.forEach(p => {
            io.to(p.socketId).emit('requestVote', room.players.filter(target => target.isAlive && target.id !== p.id).map(t => ({ id: t.id, name: t.name })));
        });

        // If no active human players, trigger computer vote and resolve automatically
        if (activeHumanPlayers.length === 0) {
             setTimeout(() => {
                performComputerDayVote(roomCode);
                resolveDayVote(roomCode);
            }, 2000);
        } else {
            // In a real game, you'd have a timer here. After the timer, check who voted, then run computer votes, then resolve.
            // For this simplified example, we'll rely on human submissions to trigger resolution.
        }
    }

    socket.on('submitVote', (data) => {
        const { roomCode, voterId, targetId } = data;
        const room = rooms[roomCode];
        const voter = room.players.find(p => p.id === voterId);
        const target = room.players.find(p => p.id === targetId);

        if (room && room.gamePhase === 'day' && voter && voter.isAlive && !voter.hasVoted && voter.socketId === socket.id && target && target.isAlive && voterId !== targetId) {
            if (room.votes[targetId]) {
                room.votes[targetId]++;
            } else {
                room.votes[targetId] = 1;
            }
            voter.hasVoted = true;
            addChatMessage(roomCode, `${voter.name} memilih untuk menggantung ${target.name}.`);
            io.to(voter.socketId).emit('actionSubmitted');

            const allAlivePlayers = room.players.filter(p => p.isAlive);
            // Consider all players: humans (must vote) and computers (will auto-vote)
            const allActivePlayersVoted = allAlivePlayers.every(p => p.hasVoted || p.type === 'computer');

            if (allActivePlayersVoted) {
                performComputerDayVote(roomCode); // Ensure computer players vote
                setTimeout(() => resolveDayVote(roomCode), 1000);
            }
        } else {
            io.to(socket.id).emit('actionError', 'Vote tidak valid atau sudah memilih.');
        }
    });

    function performComputerDayVote(roomCode) {
        const room = rooms[roomCode];
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
                if (room.votes[targetPlayer.id]) {
                    room.votes[targetPlayer.id]++;
                } else {
                    room.votes[targetPlayer.id] = 1;
                }
                computerPlayer.hasVoted = true;
                addChatMessage(roomCode, `${computerPlayer.name} (Komputer) memilih untuk menggantung ${targetPlayer.name}.`);
            }
        });
    }

    function resolveDayVote(roomCode) {
        const room = rooms[roomCode];
        let maxVotes = 0;
        let playersToHang = [];

        if (Object.keys(room.votes).length === 0) {
            addChatMessage(roomCode, 'Tidak ada yang digantung hari ini.');
            setTimeout(() => startNightPhase(roomCode), 3000);
            return;
        }

        for (const targetId in room.votes) {
            if (room.votes[targetId] > maxVotes) {
                maxVotes = room.votes[targetId];
                playersToHang = [parseInt(targetId)];
            } else if (room.votes[targetId] === maxVotes) {
                playersToHang.push(parseInt(targetId));
            }
        }

        if (playersToHang.length === 1) {
            const hungPlayer = room.players.find(p => p.id === playersToHang[0]);
            if (hungPlayer) {
                hungPlayer.isAlive = false;
                addChatMessage(roomCode, `Desa telah menggantung <strong>${hungPlayer.name}</strong>. Perannya adalah <strong>${hungPlayer.role}</strong>.`);
            }
        } else {
            addChatMessage(roomCode, 'Tidak ada yang digantung hari ini karena seri suara atau tidak ada yang memilih.');
        }

        room.votes = {}; // Clear votes for next day

        io.to(roomCode).emit('updatePlayerList', room.players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, type: p.type, socketId: p.socketId })));
        checkGameEnd(roomCode);
        if (room.gamePhase !== 'gameOver') {
            setTimeout(() => startNightPhase(roomCode), 3000);
        }
    }
    
    function startNightPhase(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.gamePhase === 'gameOver') return;
        room.gamePhase = 'night';
        room.werewolfKillTarget = null;
        room.doctorProtectTarget = null;
        room.players.forEach(p => p.actionChosen = false);

        io.to(roomCode).emit('updateGamePhase', 'Malam Hari (Aksi Peran)');
        addChatMessage(roomCode, 'Ini adalah malam hari. Werewolf berburu, Dokter melindungi, dan Seer melihat.');
        
        const activeHumanWerewolves = room.players.filter(p => p.isAlive && p.type === 'human' && p.role === 'Werewolf' && p.socketId !== null);
        const activeHumanDoctors = room.players.filter(p => p.isAlive && p.type === 'human' && p.role === 'Doctor' && p.socketId !== null);
        const activeHumanSeers = room.players.filter(p => p.isAlive && p.type === 'human' && p.role === 'Seer' && p.socketId !== null);

        // Request actions from active human players
        activeHumanWerewolves.forEach(p => {
            io.to(p.socketId).emit('requestWerewolfKill', room.players.filter(target => target.isAlive && target.role !== 'Werewolf').map(t => ({ id: t.id, name: t.name })));
        });
        activeHumanDoctors.forEach(p => {
            io.to(p.socketId).emit('requestDoctorProtect', room.players.filter(target => target.isAlive).map(t => ({ id: t.id, name: t.name })));
        });
        activeHumanSeers.forEach(p => {
            io.to(p.socketId).emit('requestSeerReveal', room.players.filter(target => target.isAlive).map(t => ({ id: t.id, name: t.name })));
        });
        
        // Set a timeout to resolve night actions. This needs to be robust for multiplayer.
        // For simplicity, it triggers after a fixed time (e.g., 5 seconds), assuming human actions are quick or computer handles them.
        setTimeout(() => {
            performComputerNightActions(roomCode); // Ensure computer players act
            resolveNightActions(roomCode);
        }, 5000); 
    }

    socket.on('submitWerewolfKill', (data) => {
        const { roomCode, voterId, targetId } = data; // voterId here is the killerId
        const room = rooms[roomCode];
        const killer = room.players.find(p => p.id === voterId);
        const target = room.players.find(p => p.id === targetId);
        if (room && room.gamePhase === 'night' && killer && killer.isAlive && killer.role === 'Werewolf' && !killer.actionChosen && killer.socketId === socket.id && target && target.isAlive && target.role !== 'Werewolf') {
            room.werewolfKillTarget = target;
            killer.actionChosen = true;
            addChatMessage(roomCode, `${killer.name} memilih untuk membunuh ${target.name}.`);
            io.to(killer.socketId).emit('actionSubmitted');
        } else {
            io.to(socket.id).emit('actionError', 'Aksi Werewolf tidak valid.');
        }
    });

    socket.on('submitDoctorProtect', (data) => {
        const { roomCode, voterId, targetId } = data; // voterId here is the doctorId
        const room = rooms[roomCode];
        const doctor = room.players.find(p => p.id === voterId);
        const target = room.players.find(p => p.id === targetId);
        if (room && room.gamePhase === 'night' && doctor && doctor.isAlive && doctor.role === 'Doctor' && !doctor.actionChosen && doctor.socketId === socket.id && target && target.isAlive) {
            room.doctorProtectTarget = target;
            doctor.actionChosen = true;
            addChatMessage(roomCode, `${doctor.name} memilih untuk melindungi ${target.name}.`);
            io.to(doctor.socketId).emit('actionSubmitted');
        } else {
            io.to(socket.id).emit('actionError', 'Aksi Dokter tidak valid.');
        }
    });

    socket.on('submitSeerReveal', (data) => {
        const { roomCode, voterId, targetId } = data; // voterId here is the seerId
        const room = rooms[roomCode];
        const seer = room.players.find(p => p.id === voterId);
        const target = room.players.find(p => p.id === targetId);
        if (room && room.gamePhase === 'night' && seer && seer.isAlive && seer.role === 'Seer' && !seer.actionChosen && seer.socketId === socket.id && target && target.isAlive) {
            // Seer's reveal is private, so send only to the seer.
            io.to(seer.socketId).emit('newChatMessage', `<span style="color: green;">[Peran ${target.name} adalah ${target.role}]</span>`, false);
            addChatMessage(roomCode, `${seer.name} melihat peran ${target.name}.`); // Public log just says they looked
            seer.actionChosen = true;
            io.to(seer.socketId).emit('actionSubmitted');
        } else {
            io.to(socket.id).emit('actionError', 'Aksi Seer tidak valid.');
        }
    });
    
    function performComputerNightActions(roomCode) {
        const room = rooms[roomCode];
        const aliveComputerWerewolves = room.players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Werewolf' && !p.actionChosen);
        const aliveComputerDoctors = room.players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Doctor' && !p.actionChosen);
        const aliveComputerSeers = room.players.filter(p => p.isAlive && p.type === 'computer' && p.role === 'Seer' && !p.actionChosen);

        if (aliveComputerWerewolves.length > 0) {
            const potentialTargets = room.players.filter(p => p.isAlive && p.role !== 'Werewolf');
            if (potentialTargets.length > 0) {
                room.werewolfKillTarget = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                addChatMessage(roomCode, `${aliveComputerWerewolves[0].name} (Komputer Werewolf) memilih untuk membunuh ${room.werewolfKillTarget.name}.`);
            }
            aliveComputerWerewolves.forEach(p => p.actionChosen = true);
        }

        if (aliveComputerDoctors.length > 0) {
            const target = room.players.filter(p => p.isAlive)[Math.floor(Math.random() * room.players.filter(p => p.isAlive).length)];
            room.doctorProtectTarget = target;
            addChatMessage(roomCode, `${aliveComputerDoctors[0].name} (Komputer Dokter) memilih untuk melindungi ${room.doctorProtectTarget.name}.`);
            aliveComputerDoctors.forEach(p => p.actionChosen = true);
        }

        if (aliveComputerSeers.length > 0) {
            const target = room.players.filter(p => p.isAlive)[Math.floor(Math.random() * room.players.filter(p => p.isAlive).length)];
            addChatMessage(roomCode, `${aliveComputerSeers[0].name} (Komputer Seer) melihat peran ${target.name}.`);
            aliveComputerSeers.forEach(p => p.actionChosen = true);
        }
    }


    function resolveNightActions(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.gamePhase === 'gameOver') return;

        let killedPlayer = null;

        if (room.werewolfKillTarget) {
            if (room.doctorProtectTarget && room.werewolfKillTarget.id === room.doctorProtectTarget.id) {
                addChatMessage(roomCode, `Malam ini ${room.werewolfKillTarget.name} diserang Werewolf tapi diselamatkan oleh Dokter.`);
            } else {
                killedPlayer = room.werewolfKillTarget;
                killedPlayer.isAlive = false;
                addChatMessage(roomCode, `Malam ini, <strong>${killedPlayer.name}</strong> dimangsa oleh Werewolf. Perannya adalah <strong>${killedPlayer.role}</strong>.`);
            }
        } else {
            addChatMessage(roomCode, 'Tidak ada yang dimangsa malam ini.');
        }

        io.to(roomCode).emit('updatePlayerList', room.players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, type: p.type, socketId: p.socketId })));
        checkGameEnd(roomCode);
        if (room.gamePhase !== 'gameOver') {
            setTimeout(() => startDayPhase(roomCode), 3000);
        }
    }

    function checkGameEnd(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.gamePhase === 'gameOver') return;
        const aliveWerewolves = room.players.filter(p => p.isAlive && p.role === 'Werewolf');
        const aliveVillagers = room.players.filter(p => p.isAlive && p.role !== 'Werewolf');
        const alivePlayersCount = room.players.filter(p => p.isAlive).length;

        if (aliveWerewolves.length === 0) {
            room.gamePhase = 'gameOver';
            io.to(roomCode).emit('gameOver', 'Selamat! Penduduk desa memenangkan permainan!');
            addChatMessage(roomCode, 'Permainan berakhir. Penduduk desa menang!');
        } else if (aliveWerewolves.length >= aliveVillagers.length) {
            room.gamePhase = 'gameOver';
            io.to(roomCode).emit('gameOver', 'Maaf! Werewolf memenangkan permainan!');
            addChatMessage(roomCode, 'Permainan berakhir. Werewolf menang!');
        } else if (alivePlayersCount < 3) { // Not enough players to continue the game fairly
            room.gamePhase = 'gameOver';
            io.to(roomCode).emit('gameOver', 'Permainan berakhir karena jumlah pemain terlalu sedikit untuk melanjutkan!');
            addChatMessage(roomCode, 'Permainan berakhir karena jumlah pemain terlalu sedikit untuk melanjutkan.');
        }
    }
});

server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
