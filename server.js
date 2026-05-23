const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');

// ⚙️ [CONFIG] ตั้งค่าความยาวสูงสุดตรงนี้ได้ตามใจชอบเลยครับ! 
const MAX_CHAT_LENGTH = 500; //อยากเปลี่ยนเป็น 255, 315, 30000  
const MAX_NAME_LENGTH = 24; // อยากเปลี่ยนเป็น 32, 64, 128  

const app = express();
app.use(cookieParser());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'lan_share.db'), { verbose: console.log });

db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deviceId TEXT,
        senderName TEXT,
        text TEXT,
        time TEXT
    );
    CREATE TABLE IF NOT EXISTS devices (
        deviceId TEXT PRIMARY KEY,
        name TEXT
    );
`);

function getDynamicNetworkInfo() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

function sanitizeInput(text) {
    if (!text) return "";
    return text.toString().replace(/[\x00-\x1F\x7F]/g, "");
}

const clients = new Map();

function getActiveDeviceIds() {
    const activeIds = [];
    clients.forEach((client) => {
        if (client.deviceId && !activeIds.includes(client.deviceId)) {
            activeIds.push(client.deviceId);
        }
    });
    return activeIds;
}

function getPeerListArray() {
    const ipCounts = {};
    clients.forEach((client) => {
        ipCounts[client.ip] = (ipCounts[client.ip] || 0) + 1;
    });

    const uniquePeersMap = new Map();
    clients.forEach((value) => {
        if (!uniquePeersMap.has(value.ip)) {
            uniquePeersMap.set(value.ip, {
                ip: value.ip,
                deviceName: value.deviceName,
                tabCount: ipCounts[value.ip]
            });
        }
    });
    return Array.from(uniquePeersMap.values());
}

function broadcastPeerList() {
    const peerList = getPeerListArray();
    const activeIds = getActiveDeviceIds();

    clients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
                type: 'peers',
                peers: peerList,
                activeDeviceIds: activeIds
            }));
        }
    });
}

function generateRandomAnimalName() {
    const names = ["นกเพนกวิน", "แมวน้ำ", "วาฬเพชรฆาต", "กระรอกบิน", "ทานูกิ", "ลูกเป็ด", "หมีแพนด้า", "จิงโจ้", "สลอธ", "สุนัขจิ้งจอก"];
    return names[Math.floor(Math.random() * names.length)] + "_" + Math.floor(100 + Math.random() * 900);
}

function resolveDeviceDisplayName(deviceId, reqCookies) {
    const row = db.prepare("SELECT name FROM devices WHERE deviceId = ?").get(deviceId);
    if (row && row.name) return row.name;

    if (reqCookies && reqCookies.device_custom_name) {
        const decodedName = decodeURIComponent(reqCookies.device_custom_name).trim();
        if (decodedName) {
            // ตัดสิทธิ์ความยาวที่ฝั่ง Server ป้องกันการบายพาสสคริปต์
            const cleanName = decodedName.substring(0, MAX_NAME_LENGTH);
            db.prepare("INSERT OR REPLACE INTO devices (deviceId, name) VALUES (?, ?)").run(deviceId, cleanName);
            return cleanName;
        }
    }

    const generatedName = generateRandomAnimalName();
    db.prepare("INSERT OR REPLACE INTO devices (deviceId, name) VALUES (?, ?)").run(deviceId, generatedName);
    return generatedName;
}

wss.on('connection', (ws, req) => {
    const sessionId = 'session_' + Math.random().toString(36).substring(2, 15);

    let rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    if (rawIp.includes('::ffff:')) {
        rawIp = rawIp.split('::ffff:')[1];
    }
    if (rawIp === '::1') {
        rawIp = '127.0.0.1';
    }

    const cookieHeader = req.headers.cookie || '';
    const parsedCookies = {};
    cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        if (parts.length === 2) {
            parsedCookies[parts[0].trim()] = parts[1].trim();
        }
    });

    let clientDeviceId = parsedCookies['device_id'];
    if (clientDeviceId) {
        clientDeviceId = decodeURIComponent(clientDeviceId);
    } else {
        clientDeviceId = 'dev_fallback_' + Math.random().toString(36).substring(2, 11);
    }

    const clientDisplayName = resolveDeviceDisplayName(clientDeviceId, parsedCookies);

    clients.set(sessionId, {
        ws: ws,
        ip: rawIp,
        deviceId: clientDeviceId,
        deviceName: clientDisplayName
    });

    const chatHistory = db.prepare("SELECT deviceId, senderName, text, time FROM chats ORDER BY id DESC LIMIT 40").all();
    chatHistory.reverse();

    ws.send(JSON.stringify({
        type: 'init',
        myId: sessionId,
        myIp: rawIp,
        currentName: clientDisplayName,
        activeDeviceIds: getActiveDeviceIds(),
        chatHistory: chatHistory,
        maxChatLength: MAX_CHAT_LENGTH,
        maxNameLength: MAX_NAME_LENGTH // 👈 ส่งค่าความยาวชื่อเล่นที่ Server ตั้งไว้ไปให้หน้าเว็บใช้งาน
    }));

    broadcastPeerList();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const currentSession = clients.get(sessionId);
            if (!currentSession) return;

            if (data.type === 'update_name' && data.newName) {
                const cleanName = sanitizeInput(data.newName).trim().substring(0, MAX_NAME_LENGTH);
                if (cleanName) {
                    // 1. อัปเดตชื่อในฐานข้อมูลอุปกรณ์
                    db.prepare("INSERT OR REPLACE INTO devices (deviceId, name) VALUES (?, ?)").run(currentSession.deviceId, cleanName);

                    // 2. อัปเดตชื่อผู้ส่งในฐานข้อมูลแชทเก่าทั้งหมด
                    db.prepare("UPDATE chats SET senderName = ? WHERE deviceId = ?").run(cleanName, currentSession.deviceId);

                    // 3. อัปเดตชื่อในหน่วยความจำเซิร์ฟเวอร์ (RAM)
                    clients.forEach((cli) => {
                        if (cli.deviceId === currentSession.deviceId) {
                            cli.deviceName = cleanName;
                        }
                    });

                    // 4. สั่งอัปเดตรายชื่อคนออนไลน์ในโซนอุปกรณ์ (ของเดิม)
                    broadcastPeerList();

                    // 🔥 [เพิ่มจุดนี้] ดึงประวัติแชทล่าสุดจาก DB แล้วพ่นบอกทุกคนให้เปลี่ยนชื่อในแชททันทีแบบ Real-time!
                    const updatedChatHistory = db.prepare("SELECT deviceId, senderName, text, time FROM chats ORDER BY id DESC LIMIT 40").all();
                    updatedChatHistory.reverse();

                    clients.forEach((client) => {
                        if (client.ws.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                                type: 'init', // ใช้ type 'init' เพื่อให้หน้าเว็บของทุกคนจับรีเรนเดอร์แชทใหม่ทันที
                                myId: client.ws === ws ? sessionId : undefined, // ส่ง id กลับไปเฉพาะเจ้าตัว
                                myIp: client.ip,
                                currentName: client.deviceName,
                                activeDeviceIds: getActiveDeviceIds(),
                                chatHistory: updatedChatHistory, // ส่งประวัติที่อัปเดตชื่อแล้วไปให้ทุกคน
                                maxChatLength: MAX_CHAT_LENGTH,
                                maxNameLength: MAX_NAME_LENGTH
                            }));
                        }
                    });
                }
            }

            if (data.type === 'chat_message' && data.text) {
                const cleanText = sanitizeInput(data.text).trim().substring(0, MAX_CHAT_LENGTH);
                if (!cleanText) return;

                const now = new Date();
                const timeString = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });

                const msgObject = {
                    deviceId: currentSession.deviceId,
                    senderName: currentSession.deviceName,
                    text: cleanText,
                    time: timeString
                };

                db.prepare("INSERT INTO chats (deviceId, senderName, text, time) VALUES (?, ?, ?, ?)").run(
                    msgObject.deviceId,
                    msgObject.senderName,
                    msgObject.text,
                    msgObject.time
                );

                const activeIds = getActiveDeviceIds();

                clients.forEach((client) => {
                    if (client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({
                            type: 'new_chat_message',
                            message: msgObject,
                            activeDeviceIds: activeIds
                        }));
                    }
                });
            }



            // --- 📂 โซนบริหารจัดการสะพานสัญญานขารับ-ส่งไฟล์ P2P ด้วย State แบบ Real-time ---

            // สัญญาณขั้นที่ 1: แจ้งเตือนส่งคำร้องขอ
            if (data.type === 'file_request' && data.targetIp) {
                clients.forEach((client) => {
                    if (client.ip === data.targetIp && client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({
                            type: 'file_request',
                            senderIp: currentSession.ip, // แนบ IP ผู้ส่งกลับไปให้ผู้รับรู้
                            fileName: data.fileName,
                            fileSize: data.fileSize,
                            fileType: data.fileType
                        }));
                    }
                });
            }

            // สัญญาณขั้นที่ 2: ปลายทางยอมรับ ให้ฝั่งส่งเริ่มสตรีมได้
            if (data.type === 'file_accept' && data.targetIp) {
                clients.forEach((client) => {
                    if (client.ip === data.targetIp && client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({ type: 'file_start_stream' }));
                    }
                });
            }

            // สัญญาณขั้นที่ 3: ปฏิเสธ หรือกดยกเลิก
            if ((data.type === 'file_reject' || data.type === 'file_rejected') && data.targetIp) {
                clients.forEach((client) => {
                    if (client.ip === data.targetIp && client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({ type: 'file_cancelled' }));
                    }
                });
            }

            // สัญญาณขั้นที่ 4: ลำเลียงก้อนข้อมูลย่อย (Chunk) พร้อมอัปเดตสเตตัสปลายทาง
            if (data.type === 'file_chunk' && data.targetIp) {
                clients.forEach((client) => {
                    if (client.ip === data.targetIp && client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({
                            type: 'file_chunk_receive',
                            fileName: data.fileName,
                            fileType: data.fileType,
                            payload: data.payload,
                            isEnd: data.isEnd
                        }));
                    }
                });
            }
        } catch (e) {
            console.error("Error operational routing:", e);
        }
    });

    ws.on('close', () => {
        clients.delete(sessionId);
        broadcastPeerList();
    });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
    const serverLanIp = getDynamicNetworkInfo();
    console.log(`\n=====================================================`);
    console.log(`🚀 เซิร์ฟเวอร์ระบบแลกเปลี่ยนไฟล์และแชทเริ่มทำงานแล้ว!`);
    console.log(`🔗 http://${serverLanIp}:${PORT}`);
    console.log(`=====================================================\n`);
});