const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// public 폴더와 루트 폴더 모두 지원 (index.html을 어느 위치에 두어도 정상 접속)
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
app.use(express.static(__dirname));

// 클라이언트가 전용 실시간 서버 연결 여부를 자동 감지하는 엔드포인트
app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'lol-moba-socketio', rooms: Object.keys(rooms).length });
});

app.get('/', (req, res) => {
  const publicIndex = path.join(publicDir, 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  res.status(404).send('index.html 파일을 찾을 수 없습니다. public/index.html 또는 루트 폴더에 넣어주세요.');
});

// =========================================================================
// 실시간 멀티플레이 방 관리 및 전투 패킷 중계
// =========================================================================
const rooms = {};

function sanitizeRoomForClient(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    noTurrets: !!room.noTurrets,
    members: room.members
  };
}

function removeUserFromRoom(socket, code, userId) {
  const room = rooms[code];
  if (!room || !room.members[userId]) return;

  const leavingName = room.members[userId].name;
  delete room.members[userId];
  socket.leave(code);

  const remainingHumans = Object.values(room.members).filter((m) => !m.isBot);
  if (remainingHumans.length === 0) {
    delete rooms[code];
    return;
  }

  // 방장이 나갔다면 남은 사람 중 첫 번째 플레이어에게 방장 위임
  if (room.hostId === userId) {
    room.hostId = remainingHumans[0].id;
  }

  io.to(code).emit('roomUpdate', sanitizeRoomForClient(room));
  io.to(code).emit('systemNotice', { message: `🚪 ${leavingName}님이 대기실을 나갔습니다.` });
}

io.on('connection', (socket) => {
  let joinedCode = null;
  let joinedUserId = null;

  // 1. 새 온라인 방 생성
  socket.on('createRoom', ({ code, userId, member }, ack) => {
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!cleanCode || !userId || !member) {
      if (typeof ack === 'function') ack({ ok: false, error: '잘못된 방 생성 요청입니다.' });
      return;
    }

    if (joinedCode && joinedUserId) {
      removeUserFromRoom(socket, joinedCode, joinedUserId);
    }

    rooms[cleanCode] = {
      code: cleanCode,
      hostId: userId,
      started: false,
      noTurrets: false,
      members: {
        [userId]: { ...member, id: userId, team: 'blue', isBot: false }
      }
    };

    joinedCode = cleanCode;
    joinedUserId = userId;
    socket.join(cleanCode);

    const payload = sanitizeRoomForClient(rooms[cleanCode]);
    io.to(cleanCode).emit('roomUpdate', payload);
    if (typeof ack === 'function') ack({ ok: true, room: payload });
  });

  // 2. 초대 코드로 방 참가
  socket.on('joinRoom', ({ code, userId, member }, ack) => {
    const cleanCode = String(code || '').trim().toUpperCase();
    const room = rooms[cleanCode];
    if (!room) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: `방 [${cleanCode}]을 찾을 수 없습니다. 초대 코드를 다시 확인해 주세요.` });
      }
      return;
    }

    if (room.started) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: `방 [${cleanCode}]은 이미 게임이 시작되었습니다.` });
      }
      return;
    }

    if (joinedCode && joinedUserId && joinedCode !== cleanCode) {
      removeUserFromRoom(socket, joinedCode, joinedUserId);
    }

    // 인원이 적은 팀으로 자동 배정 (1v1이면 방장은 블루, 친구는 자동으로 레드팀!)
    const allMembers = Object.values(room.members);
    const blueCount = allMembers.filter((m) => m.team === 'blue').length;
    const redCount = allMembers.filter((m) => m.team === 'red').length;
    const autoTeam = blueCount <= redCount ? 'blue' : 'red';

    room.members[userId] = {
      ...member,
      id: userId,
      team: room.members[userId]?.team || autoTeam,
      isBot: false
    };

    joinedCode = cleanCode;
    joinedUserId = userId;
    socket.join(cleanCode);

    const payload = sanitizeRoomForClient(room);
    io.to(cleanCode).emit('roomUpdate', payload);
    io.to(cleanCode).emit('memberJoined', { name: member.name || '소환사' });
    if (typeof ack === 'function') ack({ ok: true, room: payload });
  });

  // 3. 챔피언 / 룬 / 스펠 / 팀 / 준비 상태 변경 동기화
  socket.on('updateMember', ({ code, userId, member }) => {
    const room = rooms[code];
    if (!room || !room.members[userId] || !member) return;
    room.members[userId] = { ...room.members[userId], ...member, id: userId };
    io.to(code).emit('roomUpdate', sanitizeRoomForClient(room));
  });

  // 4. AI 봇 추가
  socket.on('addBot', ({ code, bot }) => {
    const room = rooms[code];
    if (!room || !bot || !bot.id) return;
    room.members[bot.id] = { ...bot, isBot: true, ready: true };
    io.to(code).emit('roomUpdate', sanitizeRoomForClient(room));
  });

  // 4-1. 커스텀 방 규칙 변경 (포탑 제거 모드 등 - 방장 전용)
  socket.on('updateRoomSettings', ({ code, userId, noTurrets }) => {
    const room = rooms[code];
    if (!room || room.hostId !== userId) return;
    room.noTurrets = !!noTurrets;
    io.to(code).emit('roomUpdate', sanitizeRoomForClient(room));
    io.to(code).emit('systemNotice', {
      message: room.noTurrets
        ? '🔥 방장이 [포탑 제거 모드]를 활성화했습니다!'
        : '🏰 방장이 [표준 포탑 모드]로 변경했습니다.'
    });
  });

  // 4-2. AI 봇 및 플레이어 추방 (방장 전용)
  socket.on('kickMember', ({ code, userId, targetId }) => {
    const room = rooms[code];
    if (!room || room.hostId !== userId || !targetId || targetId === userId) return;
    const target = room.members[targetId];
    if (!target) return;

    const kickedName = target.name || '참가자';
    delete room.members[targetId];
    io.to(code).emit('kickedMember', { targetId, name: kickedName });
    io.to(code).emit('roomUpdate', sanitizeRoomForClient(room));
    io.to(code).emit('systemNotice', { message: `🚫 ${kickedName}님이 방장에 의해 추방되었습니다.` });
  });

  // 5. 매치 시작 (방장 전용)
  socket.on('startMatch', ({ code, userId }) => {
    const room = rooms[code];
    if (!room || room.hostId !== userId) return;
    room.started = true;
    const roster = Object.values(room.members);
    io.to(code).emit('roomUpdate', sanitizeRoomForClient(room));
    io.to(code).emit('startMatch', { roster, noTurrets: !!room.noTurrets });
  });

  // 6. 방 나가기
  socket.on('leaveRoom', ({ code, userId }) => {
    removeUserFromRoom(socket, code, userId);
    if (joinedCode === code) {
      joinedCode = null;
      joinedUserId = null;
    }
  });

  // 7. 인게임 실시간 위치·스킬·데미지·포탑·핑·채팅 중계
  socket.on('gamePacket', ({ code, packet }) => {
    if (!code || !packet) return;
    socket.to(code).emit('gamePacket', packet);
  });

  // 8. 브라우저 종료 / 연결 끊김 처리
  socket.on('disconnect', () => {
    if (joinedCode && joinedUserId) {
      removeUserFromRoom(socket, joinedCode, joinedUserId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`⚔️ 소환사의 협곡 멀티플레이 서버가 포트 ${PORT}에서 실행 중입니다!`);
});
