let MAX_CHAT_LENGTH = 500;
let MAX_NAME_LENGTH = 25; // ค่าเริ่มต้นแกนหลัก (จะถูกเขียนทับทันทีด้วยค่าคอนฟิกจริงจาก Server)
let activeFileTransfer = null;

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
}

function setCookie(name, value, days) {
    const d = new Date();
    d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/`;
}

let myDeviceId = getCookie('device_id');
if (!myDeviceId) {
    myDeviceId = 'dev_' + Math.random().toString(36).substring(2, 15);
    setCookie('device_id', myDeviceId, 365);
}

const ws = new WebSocket(`ws://${window.location.host}`);
let myId = '';
let myIp = '';
let currentDisplayName = '';
let activeDeviceIdsList = [];
let chatHistoryData = [];
let currentOnlineDeviceIds = new Set();
let lastRenderedTime = '';

function escapeHTML(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function updateCharCounter() {
    const input = document.getElementById('chat-input-field');
    document.getElementById('char-counter').innerText = `${input.value.length} / ${MAX_CHAT_LENGTH}`;
}

// 📌 ฟังก์ชันตรวจนับตัวอักษรและสั่งขึ้นขอบแดงเมื่อชื่อเล่นเต็มโควตา
function updateModalCharCounter() {
    const input = document.getElementById('modal-name-input');
    const counter = document.getElementById('modal-name-counter');

    if (!input || !counter) return;

    const currentLength = input.value.length;
    counter.innerText = `${currentLength} / ${MAX_NAME_LENGTH}`;

    // ถ้าพิมพ์มาถึงเกณฑ์จำกัดสูงสุด ให้เปิดแอตทริบิวต์ขอบแดงแจ้งเตือนผู้ใช้ทันที
    if (currentLength >= MAX_NAME_LENGTH) {
        input.classList.add('limit-reached');
        counter.classList.add('limit-reached');
    } else {
        input.classList.remove('limit-reached');
        counter.classList.remove('limit-reached');
    }
}

function closeRenameModal() {
    const overlay = document.getElementById('name-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

// 📌 ฟังก์ชันบันทึกชื่อจากค่าใน Modal ซ้อนบนเว็บ
function saveDisplayNameFromModal() {
    const input = document.getElementById('modal-name-input');
    if (!input) return;

    const newName = input.value.trim();
    if (newName !== "") {
        let clean = newName.substring(0, MAX_NAME_LENGTH); // ตัดคำเซฟตี้ฝั่ง Client
        setCookie('device_custom_name', clean, 365);
        ws.send(JSON.stringify({ type: 'update_name', newName: clean }));
        currentDisplayName = clean;
        document.getElementById('display-name-text').innerText = clean;
        closeRenameModal(); // บันทึกเสร็จให้ปิดหน้าต่างทันที
    }
}

// ผูกปุ่ม Enter ในกล่อง Modal ให้กดบันทึกได้สะดวก
document.addEventListener('DOMContentLoaded', () => {
    const modalInput = document.getElementById('modal-name-input');
    if (modalInput) {
        modalInput.addEventListener('keypress', function (e) {
            if (e.key === 'Enter') saveDisplayNameFromModal();
        });
    }
});

function applyNewMaxChatLength() {
    const chatInput = document.getElementById('chat-input-field');
    if (chatInput) {
        chatInput.setAttribute('maxlength', MAX_CHAT_LENGTH);
    }
    updateCharCounter();
}

// 📌 ฟังก์ชันเปิดกล่อง Modal พร้อมใส่ค่า MaxLength แบบแปรผันตาม Server
function openRenameModal() {
    const overlay = document.getElementById('name-modal-overlay');
    const input = document.getElementById('modal-name-input');

    if (overlay && input) {
        input.value = currentDisplayName; // ดึงชื่อเดิมขึ้นมาโชว์ค้างไว้
        input.setAttribute('maxlength', MAX_NAME_LENGTH); // ผูกโควตาตามค่า Server เสมอ
        overlay.style.display = 'flex';
        input.focus();
        updateModalCharCounter();
    }
}

document.getElementById('chat-input-field').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        sendGroupChatMessage();
    }
});

ws.onmessage = function (event) {
    try {
        const data = JSON.parse(event.data);

        if (data.type === 'init') {
            if (data.maxChatLength) {
                MAX_CHAT_LENGTH = data.maxChatLength;
            }
            // 🚨 รองรับการรับค่าความยาวสูงสุดของชื่อเล่นที่ส่งมาจาก Server 
            if (data.maxNameLength) {
                MAX_NAME_LENGTH = data.maxNameLength;
            }

            document.getElementById('char-counter').innerText = `0 / ${MAX_CHAT_LENGTH}`;
            myId = data.myId;
            myIp = data.myIp;
            currentDisplayName = data.currentName;
            document.getElementById('my-identity').innerHTML = `คุณ: <b id="display-name-text">${escapeHTML(currentDisplayName)}</b> (${myIp})`;

            if (data.activeDeviceIds) {
                activeDeviceIdsList = data.activeDeviceIds;
                currentOnlineDeviceIds = new Set(data.activeDeviceIds);
            }
            chatHistoryData = data.chatHistory || [];
            renderChatHistory();
            updateOnlineCounterUI();

            if (data.maxChatLength) {
                MAX_CHAT_LENGTH = data.maxChatLength;
                applyNewMaxChatLength();
            }
        }

        if (data.type === 'peers') {
            if (data.activeDeviceIds) {
                activeDeviceIdsList = data.activeDeviceIds;
                currentOnlineDeviceIds = new Set(data.activeDeviceIds);
            }
            renderPeersList(data.peers);
            renderChatHistory();
            updateOnlineCounterUI();
        }

        if (data.type === 'new_chat_message') {
            if (data.activeDeviceIds) {
                activeDeviceIdsList = data.activeDeviceIds;
                currentOnlineDeviceIds = new Set(data.activeDeviceIds);
            }
            chatHistoryData.push(data.message);
            appendSingleMessage(data.message);
            updateOnlineCounterUI();
        }

        if (data.type === 'file') {
            const link = document.createElement('a');
            link.href = data.payload;
            link.download = data.fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }


        // --- 📂 เพิ่มเติมลอจิกระดับการสั่งการรับส่งไฟล์แยกเฟสลงใน ws.onmessage ---

        // 1. ฝั่งรับเจอสัญญาณเตือนว่ามีคนขอส่งไฟล์ให้
        if (data.type === 'file_request') {
            activeFileTransfer = { senderIp: data.senderIp, fileName: data.fileName, fileSize: data.fileSize, chunks: [] };

            showFileModal({
                icon: "📥",
                title: "มีไฟล์ส่งตรงถึงคุณ",
                body: `จากเครื่อง (${data.senderIp})\nชื่อไฟล์: ${data.fileName}\nขนาด: ${(data.fileSize / (1024 * 1024)).toFixed(2)} MB\nคุณต้องการรับไฟล์นี้หรือไม่?`,
                showProgress: false,
                actions: {
                    accept: {
                        text: "รับไฟล์",
                        click: () => {
                            ws.send(JSON.stringify({ type: 'file_accept', targetIp: data.senderIp }));
                            showFileModal({
                                icon: "📥",
                                title: "กำลังรับไฟล์",
                                body: `กำลังรับ "${data.fileName}"...`,
                                showProgress: true,
                                statusText: "กำลังดาวน์โหลด..."
                            });
                        }
                    },
                    reject: {
                        text: "ปฏิเสธ",
                        click: () => {
                            ws.send(JSON.stringify({ type: 'file_reject', targetIp: data.senderIp }));
                            closeFileModal();
                        }
                    }
                }
            });
        }

        // 2. ฝั่งส่งได้รับอนุญาตให้สตาร์ทปล่อยตัวไฟล์ได้
        if (data.type === 'file_start_stream') {
            startStreamingFile();
        }

        // 3. ปลายทางโดนปฏิเสธหรือยกเลิกการส่งไฟล์กลางคัน
        if (data.type === 'file_cancelled') {
            showFileModal({
                icon: "❌",
                title: "การส่งไฟล์ล้มเหลว",
                body: "การเชื่อมต่อถูกปฏิเสธ หรืออีกฝั่งกดยกเลิกการรับส่งไฟล์นี้แล้ว",
                showProgress: false,
                actions: { close: { text: "รับทราบ", click: closeFileModal } }
            });
        }

        // 4. ฝั่งรับทยอยประกอบเนื้อก้อนไฟล์ที่ไหลเข้ามาทีละส่วนพร้อมดันแถบเปอร์เซ็นต์โหลด
        // แก้ไขเคส file_chunk_receive ด้านใน ws.onmessage ในไฟล์ script.js
        if (data.type === 'file_chunk_receive') {
            if (!activeFileTransfer) return;

            // 🌟 แปลงก้อนข้อมูลตัวเลขที่ได้รับกลับมาเป็น Uint8Array แล้วเก็บเข้าอาเรย์
            const u8Array = new Uint8Array(data.payload);
            activeFileTransfer.chunks.push(u8Array);

            const currentReceived = activeFileTransfer.chunks.length * (1024 * 64);
            const percent = Math.min(Math.round((currentReceived / activeFileTransfer.fileSize) * 100), 100);

            document.getElementById('file-progress-bar').style.width = `${percent}%`;
            document.getElementById('file-progress-percent').innerText = `${percent}%`;

            if (data.isEnd) {
                // 🌟 [จุดสำคัญ] รวมชิ้นส่วน Binary ทั้งหมดเข้าด้วยกันผ่าน Blob ไม่กิน RAM ไม่ล่ม
                const fileBlob = new Blob(activeFileTransfer.chunks, { type: data.fileType });
                const blobUrl = URL.createObjectURL(fileBlob);

                const link = document.createElement('a');
                link.href = blobUrl;
                link.download = data.fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                // คืนค่าแรมให้เบราว์เซอร์ทันที
                URL.revokeObjectURL(blobUrl);

                showFileModal({
                    icon: "🎉",
                    title: "ดาวน์โหลดเสร็จสมบูรณ์!",
                    body: `รับไฟล์ "${data.fileName}" และเซฟลงเครื่องสำเร็จแล้ว`,
                    showProgress: false,
                    actions: { close: { text: "ตกลง", click: closeFileModal } }
                });
            }
        }


        if (data.type === 'config_update') {
            if (data.maxChatLength) {
                MAX_CHAT_LENGTH = data.maxChatLength;
                applyNewMaxChatLength();
            }
            // รองรับหาก Server แอบสั่งเปลี่ยนขนาดความยาวชื่อเล่นกลางคัน
            if (data.maxNameLength) {
                MAX_NAME_LENGTH = data.maxNameLength;
                updateModalCharCounter();
            }
        }
    } catch (err) {
        console.error("Error operational routing:", err);
    }
};

function updateOnlineCounterUI() {
    const counter = document.getElementById('online-counter');
    if (counter && activeDeviceIdsList) {
        counter.innerText = activeDeviceIdsList.length;
    }
}

function renderChatHistory() {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    chatBox.innerHTML = '';
    lastRenderedTime = '';
    chatHistoryData.forEach(msg => appendSingleMessage(msg));
}

function appendSingleMessage(msg) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    const isMe = (msg.deviceId === myDeviceId);

    if (lastRenderedTime !== msg.time) {
        const timeDiv = document.createElement('div');
        timeDiv.className = 'time-divider';
        timeDiv.innerText = msg.time;
        chatBox.appendChild(timeDiv);
        lastRenderedTime = msg.time;
    }

    const msgWrapper = document.createElement('div');
    msgWrapper.className = 'msg-container';

    if (isMe) {
        msgWrapper.innerHTML = `<div class="msg me">${escapeHTML(msg.text)}</div>`;
    } else {
        const isOnlineNow = currentOnlineDeviceIds.has(msg.deviceId);
        const statusDotHtml = isOnlineNow ? `<span class="chat-status-dot" title="ผู้ใช้กำลังออนไลน์"></span>` : '';

        msgWrapper.innerHTML = `
                    <div class="sender-header">
                        <span class="sender-name">${escapeHTML(msg.senderName)}</span>
                        ${statusDotHtml}
                    </div>
                    <div class="bubble-wrapper">
                        <div class="msg other">
                            ${escapeHTML(msg.text)}
                        </div>
                    </div>
                `;
    }

    chatBox.appendChild(msgWrapper);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function renderPeersList(peers) {
    const container = document.getElementById('peers-container');
    if (!container) return;
    container.innerHTML = '';
    let hasPeers = false;
    peers.forEach(peer => {
        if (peer.ip === myIp) {
            const alertBox = document.getElementById('alert-box');
            if (peer.tabCount > 1) {
                alertBox.style.display = 'block';
            } else {
                alertBox.style.display = 'none';
            }
            return;
        }
        hasPeers = true;
        const safeIpId = peer.ip.replace(/\./g, '_');
        const div = document.createElement('div');
        div.className = 'peer-box';
        div.innerHTML = `
                    <div class="peer-info">
                        <span class="peer-name">${escapeHTML(peer.deviceName)}</span>
                        <span class="peer-ip">IP: ${peer.ip} ${peer.tabCount > 1 ? '(เปิดอยู่ ' + peer.tabCount + ' แท็บ)' : ''}</span>
                    </div>
                    <div>
                        <input type="file" id="file-${safeIpId}" style="display:none" onchange="sendFile('${peer.ip}', '${safeIpId}')">
                        <button class="btn-send-file" onclick="document.getElementById('file-${safeIpId}').click()">ส่งไฟล์</button>
                    </div>
                `;
        container.appendChild(div);
    });
    if (!hasPeers) {
        container.innerHTML = '<div style="color:#65676b; font-size:13px; margin:10px 0; font-weight:500; text-align:center;">ไม่มีอุปกรณ์อื่นออนไลน์อยู่ในวง LAN เดียวกัน</div>';
    }
}

function changeDisplayName() {
    const newName = prompt("พิมพ์ชื่อเล่นใหม่ของคุณ:", currentDisplayName);
    if (newName && newName.trim() !== "") {
        // 👈 เปลี่ยนเป็นอ้างอิงตามค่าตัวแปร MAX_NAME_LENGTH ที่ไหลมาจากเซิร์ฟเวอร์แบบยืดหยุ่น
        let clean = newName.trim().substring(0, MAX_NAME_LENGTH);
        setCookie('device_custom_name', clean, 365);
        ws.send(JSON.stringify({ type: 'update_name', newName: clean }));
        currentDisplayName = clean;
        document.getElementById('display-name-text').innerText = clean;
    }
}

function sendGroupChatMessage() {
    const input = document.getElementById('chat-input-field');
    const text = input.value.trim();

    if (!text || text.length > MAX_CHAT_LENGTH) return;

    ws.send(JSON.stringify({ type: 'chat_message', text: text }));
    input.value = '';
    document.getElementById('char-counter').innerText = `0 / ${MAX_CHAT_LENGTH}`;
}

// 📌 ปรับปรุงฟังก์ชันการริเริ่มส่งไฟล์ (ฝั่งส่ง)
function sendFile(targetIp, safeIpId) {
    const fileInput = document.getElementById(`file-${safeIpId}`);
    const file = fileInput.files[0];
    if (!file) return;

    // ล็อกเก็บข้อมูลไฟล์เตรียมพร้อมในหน่วยความจำ
    activeFileTransfer = {
        file: file,
        targetIp: targetIp,
        safeIpId: safeIpId
    };

    // ส่งสัญญาณไปเคาะห้องบอกเครื่องปลายทางก่อนว่า "มีคนจะส่งไฟล์ให้" (ยังไม่ส่งเนื้อไฟล์จริง)
    ws.send(JSON.stringify({
        type: 'file_request',
        targetIp: targetIp,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size
    }));

    // เปิดป๊อปอัปฝั่งส่งขึ้นมาค้างเพื่อรอ
    showFileModal({
        icon: "⏳",
        title: "กำลังรอการตอบกลับ",
        body: `กำลังขอส่งไฟล์ "${file.name}" ไปยังเครื่องปลายทาง...`,
        showProgress: false,
        actions: {
            reject: { text: "ยกเลิกการส่ง", click: cancelFileTransfer }
        }
    });
}

// 📌 ฟังก์ชันสั่งยกเลิกฟลูวรับส่งไฟล์กลางคัน
function cancelFileTransfer() {
    if (activeFileTransfer && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'file_rejected',
            targetIp: activeFileTransfer.targetIp
        }));
    }
    closeFileModal();
}

// 📌 ฟังก์ชันอัปเดตระบบสั่งการหน้าต่าง Pop-up สากลของระบบส่งไฟล์
function showFileModal(config) {
    document.getElementById('file-modal-icon').innerText = config.icon || "📁";
    document.getElementById('file-modal-title').innerText = config.title;
    document.getElementById('file-modal-body').innerText = config.body;

    const progressContainer = document.getElementById('file-progress-container');
    const progressBar = document.getElementById('file-progress-bar');
    const progressPercent = document.getElementById('file-progress-percent');
    const progressStatus = document.getElementById('file-progress-status');

    if (config.showProgress) {
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        progressPercent.innerText = '0%';
        progressStatus.innerText = config.statusText || 'กำลังเตรียมการ...';
    } else {
        progressContainer.style.display = 'none';
    }

    const btnReject = document.getElementById('file-btn-reject');
    const btnAccept = document.getElementById('file-btn-accept');
    const btnClose = document.getElementById('file-btn-close');

    btnReject.style.display = config.actions?.reject ? 'block' : 'none';
    btnAccept.style.display = config.actions?.accept ? 'block' : 'none';
    btnClose.style.display = config.actions?.close ? 'block' : 'none';

    if (config.actions?.reject) {
        btnReject.innerText = config.actions.reject.text;
        btnReject.onclick = config.actions.reject.click;
    }
    if (config.actions?.accept) {
        btnAccept.innerText = config.actions.accept.text;
        btnAccept.onclick = config.actions.accept.click;
    }
    if (config.actions?.close) {
        btnClose.innerText = config.actions.close.text;
        btnClose.onclick = config.actions.close.click;
    }

    document.getElementById('file-modal-overlay').style.display = 'flex';
}

function closeFileModal() {
    document.getElementById('file-modal-overlay').style.display = 'none';
    activeFileTransfer = null;
}

// แก้ไขด้านในฟังก์ชัน startStreamingFile ในไฟล์ script.js
function startStreamingFile() {
    if (!activeFileTransfer) return;
    const { file, targetIp } = activeFileTransfer;

    showFileModal({
        icon: "📤",
        title: "กำลังอัปโหลดไฟล์",
        body: `กำลังส่ง "${file.name}"...`,
        showProgress: true,
        statusText: "กำลังอัปโหลด..."
    });

    const CHUNK_SIZE = 1024 * 64;
    let offset = 0;
    const reader = new FileReader();

    reader.onload = function (e) {
        if (!activeFileTransfer) return;

        // 🌟 แปลง ArrayBuffer ที่อ่านได้ ให้เป็น Array ธรรมดาเพื่อส่งผ่าน JSON ดิบๆ
        const arrayBuffer = e.target.result;
        const uint8Array = new Uint8Array(arrayBuffer);
        const chunkArray = Array.from(uint8Array);

        ws.send(JSON.stringify({
            type: 'file_chunk',
            targetIp: targetIp,
            fileName: file.name,
            fileType: file.type,
            payload: chunkArray, // ส่งเป็นอาร์เรย์ตัวเลขดิบ ไม่ใช่ข้อความ Base64
            isEnd: (offset + CHUNK_SIZE >= file.size)
        }));

        offset += CHUNK_SIZE;

        const percent = Math.min(Math.round((offset / file.size) * 100), 100);
        document.getElementById('file-progress-bar').style.width = `${percent}%`;
        document.getElementById('file-progress-percent').innerText = `${percent}%`;

        if (offset < file.size) {
            readNextChunk();
        } else {
            showFileModal({
                icon: "✅",
                title: "ส่งไฟล์สำเร็จ!",
                body: `ส่งไฟล์ "${file.name}" เรียบร้อยแล้ว`,
                showProgress: false,
                actions: { close: { text: "ตกลง", click: closeFileModal } }
            });
        }
    };

    function readNextChunk() {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice); // 👈 🌟 เปลี่ยนจากเดิมให้เป็น readAsArrayBuffer
    }

    readNextChunk();
}