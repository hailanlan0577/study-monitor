// ============================================================
// 专注监督 · Study Monitor
// 摄像头人脸检测 + 姿态判断，开小差自动提醒
// 所有画面只在本地浏览器处理，不上传任何数据
// ============================================================

(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const video = $("video");
  const overlay = $("overlay");
  const ctx = overlay.getContext("2d");
  const connBadge = $("connBadge");
  const faceStatus = $("faceStatus");
  const alertOverlay = $("alertOverlay");
  const alertText = $("alertText");
  const alertBtn = $("alertBtn");
  const stateDot = $("stateDot");
  const stateText = $("stateText");
  const timerEl = $("timer");
  const focusPct = $("focusPct");
  const distCount = $("distCount");
  const distTime = $("distTime");
  const logList = $("logList");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const graceInput = $("grace");
  const graceVal = $("graceVal");
  const sensSelect = $("sens");
  const optSound = $("optSound");
  const optVibrate = $("optVibrate");
  const optVoice = $("optVoice");

  // ---------- 状态 ----------
  const SENS = {
    loose:  { centerX: 0.35, centerY: 0.38, minW: 0.12, ear: 0.12 },
    normal: { centerX: 0.28, centerY: 0.32, minW: 0.16, ear: 0.15 },
    strict: { centerX: 0.20, centerY: 0.26, minW: 0.20, ear: 0.18 },
  };

  let session = null;          // 学习会话 {startedAt, focusMs, distMs, distEvents, lastTick, running}
  let distState = null;        // 开小差检测 {reason, since, alerted, closedSince}
  let modelsLoaded = false;
  let stream = null;
  let rafId = null;
  let detectTimer = null;

  // ---------- 音频提醒（WebAudio 蜂鸣） ----------
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const seq = [[880, .18], [0, .12], [880, .18], [0, .12], [1180, .4]];
      seq.forEach(([f, d], i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.type = "square"; o.frequency.value = f;
        const t = audioCtx.currentTime + i * .3;
        g.gain.setValueAtTime(0.15, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + d);
        o.start(t); o.stop(t + d + .02);
      });
    } catch (e) {}
  }
  function speak(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN"; u.rate = 1.05;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  function alertUser(msg) {
    if (optSound.checked) beep();
    if (optVibrate.checked && navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
    if (optVoice.checked) speak("喂，别开小差，快回来学习");
    alertText.textContent = msg;
    alertOverlay.classList.remove("hidden");
  }

  // ---------- 几何工具 ----------
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  // 眼睑开合度 EAR：越小=眼睛闭得越厉害
  function eyeAspectRatio(pts) {
    // 左眼 36-41, 右眼 42-47（face-api 68 点）
    const L = [
      [dist(pts[37], pts[41]) + dist(pts[38], pts[40])] / (2 * dist(pts[36], pts[39])),
      [dist(pts[43], pts[47]) + dist(pts[44], pts[46])] / (2 * dist(pts[42], pts[45])),
    ];
    return (L[0] + L[1]) / 2;
  }

  // ---------- 检测循环 ----------
  async function detect() {
    if (!session || !session.running) return;
    try {
      const res = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks();

      drawOverlay(res);
      evaluate(res);
    } catch (e) {
      // 模型未就绪等，忽略
    }
  }

  function drawOverlay(res) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!res) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const bw = res.detection.box.width / vw, bh = res.detection.box.height / vh;
    const bx = res.detection.box.x / vw, by = res.detection.box.y / vh;
    const cx = bx + bw / 2, cy = by + bh / 2;
    // 画框（镜像显示）
    const X = (x) => (1 - x) * overlay.width;
    const Y = (y) => y * overlay.height;
    ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 3;
    ctx.strokeRect(X(bx + bw), Y(by), bw * overlay.width, bh * overlay.height);
    // 画眼睛关键点（landmarks 坐标已是视频像素坐标）
    ctx.fillStyle = "#38bdf8";
    const pts = res.landmarks.positions;
    for (const i of [...Array(6).keys()].map(k => k + 36).concat([...Array(6).keys()].map(k => k + 42))) {
      ctx.beginPath();
      ctx.arc(X(pts[i].x / vw), Y(pts[i].y / vh), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- 专注状态评估 ----------
  function evaluate(res) {
    const s = SENS[sensSelect.value];
    const vw = video.videoWidth, vh = video.videoHeight;
    let reason = null;

    if (!res) {
      reason = "找不到你的脸（离开摄像头了？）";
    } else {
      const box = res.detection.box;
      const bw = box.width / vw, bh = box.height / vh;
      const cx = (box.x + box.width / 2) / vw;
      const cy = (box.y + box.height / 2) / vh;
      const ear = eyeAspectRatio(res.landmarks.positions);

      if (bw < s.minW || bh < s.minW * 1.2) reason = "脸离得太远（低头玩手机？）";
      else if (Math.abs(cx - 0.5) > s.centerX) reason = "头偏了，没看屏幕";
      else if (Math.abs(cy - 0.45) > s.centerY) reason = cy < 0.45 - s.centerY ? "低头了" : "抬头了，别走神";
      else if (ear < s.ear) {
        // 闭眼：累计超过 1.2 秒才算（过滤眨眼）
        distState = distState || {};
        distState.closedSince = (distState.closedSince || Date.now());
        if (Date.now() - distState.closedSince > 1200) reason = "闭眼太久，困了？";
      } else if (distState) distState.closedSince = null;
    }

    if (reason) {
      faceStatus.textContent = "⚠️ " + reason;
      markDistracted(reason);
    } else {
      faceStatus.textContent = "✅ 专注中，加油！";
      markFocused();
    }
  }

  function markDistracted(reason) {
    if (!session || !session.running) return;
    const now = Date.now();
    if (!distState || distState.reason !== reason) {
      distState = { reason, since: now, alerted: false, closedSince: null };
    }
    // 宽限结束后才提醒
    const grace = parseInt(graceInput.value, 10) * 1000;
    if (!distState.alerted && now - distState.since > grace) {
      distState.alerted = true;
      stateDot.className = "state-dot dist";
      stateText.textContent = "开小差中";
      alertUser(reason);
    }
  }

  function markFocused() {
    if (!session || !session.running) return;
    const now = Date.now();
    if (distState && distState.alerted) {
      // 一段开小差结束，记录
      const dur = Math.round((now - distState.since) / 1000);
      session.distEvents.push({ t: new Date(distState.since), dur, reason: distState.reason });
      session.distMs += dur * 1000;
      log(`⚠️ ${fmtTime(distState.since)} 开小差 ${dur}s（${distState.reason}）`, "dist");
      alertOverlay.classList.add("hidden");
      if (optVoice.checked) speak("好，继续加油");
    }
    distState = null;
    stateDot.className = "state-dot focus";
    stateText.textContent = "专注中";
  }

  // ---------- 计时器 ----------
  function tick() {
    if (!session || !session.running) return;
    const now = Date.now();
    session.focusMs += now - session.lastTick;
    session.lastTick = now;

    const total = session.focusMs + session.distMs;
    const pct = total > 0 ? Math.round((session.focusMs / total) * 100) : 100;
    focusPct.textContent = pct + "%";
    distCount.textContent = session.distEvents.length;
    distTime.textContent = Math.round(session.distMs / 1000) + "s";
    timerEl.textContent = fmtDur(session.focusMs + session.distMs);
    rafId = requestAnimationFrame(tick);
  }

  function fmtDur(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  function fmtTime(d) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function log(msg, cls) {
    const li = document.createElement("li");
    li.textContent = msg;
    if (cls) li.className = cls;
    logList.prepend(li);
    const empty = logList.querySelector(".empty");
    if (empty) empty.remove();
  }

  // ---------- 会话控制 ----------
  function startSession() {
    if (!modelsLoaded) { faceStatus.textContent = "模型还没加载完，稍等…"; return; }
    if (!stream) { faceStatus.textContent = "摄像头未就绪"; return; }
    session = {
      startedAt: Date.now(), focusMs: 0, distMs: 0,
      distEvents: [], lastTick: Date.now(), running: true,
    };
    distState = null;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    stateDot.className = "state-dot focus";
    stateText.textContent = "专注中";
    logList.innerHTML = '<li class="empty">开始记录…</li>';
    log(`📖 ${fmtTime(new Date())} 开始学习`, "focus");
    detectTimer = setInterval(detect, 400);
    rafId = requestAnimationFrame(tick);
  }

  function stopSession() {
    if (!session) return;
    session.running = false;
    clearInterval(detectTimer);
    cancelAnimationFrame(rafId);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const total = session.focusMs + session.distMs;
    log(`🏁 ${fmtTime(new Date())} 结束学习，共 ${fmtDur(total)}，专注 ${Math.round(session.focusMs / (total || 1) * 100)}%`, "focus");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stateDot.className = "state-dot";
    stateText.textContent = "已结束";
    faceStatus.textContent = "已结束，休息一下吧";
    alertOverlay.classList.add("hidden");
    session = null;
    distState = null;
  }

  // ---------- 初始化 ----------
  async function init() {
    connBadge.textContent = "加载模型…";
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri("models");
      await faceapi.nets.faceLandmark68Net.loadFromUri("models");
      modelsLoaded = true;
      connBadge.textContent = "模型就绪";
      connBadge.className = "badge ok";
      faceStatus.textContent = "请允许摄像头权限";
    } catch (e) {
      connBadge.textContent = "模型加载失败";
      connBadge.className = "badge err";
      faceStatus.textContent = "模型加载失败，检查网络后刷新";
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      overlay.width = video.clientWidth;
      overlay.height = video.clientHeight;
      faceStatus.textContent = "就绪，点「开始学习」";
      connBadge.textContent = "摄像头 OK";
    } catch (e) {
      connBadge.textContent = "摄像头被拒";
      connBadge.className = "badge err";
      faceStatus.textContent = "摄像头权限被拒绝：请用 HTTPS 访问并允许摄像头";
    }
  }

  // ---------- 事件 ----------
  startBtn.onclick = startSession;
  stopBtn.onclick = stopSession;
  alertBtn.onclick = () => {
    alertOverlay.classList.add("hidden");
    // 立即结束当前开小差判定
    if (session && session.running) { markFocused(); distState = null; }
  };
  graceInput.oninput = () => (graceVal.textContent = graceInput.value);

  init();
})();
