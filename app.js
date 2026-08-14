// ============================================================
// 专注监督 · Study Monitor (v3.0 - 增强版 AI 识别)
// face-api 68 点人脸 + 头部姿态(偏转/俯仰) + 视线方向 + 遮挡检测
// 能识别：低头看手机、眼神向下、手挡脸、凑近玩手机、闭眼、转头
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
  const phaseTag = $("phaseTag");
  const faceStatus = $("faceStatus");
  const alertOverlay = $("alertOverlay");
  const alertText = $("alertText");
  const alertBtn = $("alertBtn");
  const stateDot = $("stateDot");
  const stateText = $("stateText");
  const cycleText = $("cycleText");
  const timerEl = $("timer");
  const focusPct = $("focusPct");
  const distCount = $("distCount");
  const distTime = $("distTime");
  const logList = $("logList");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const modeFree = $("modeFree");
  const modePomodoro = $("modePomodoro");
  const graceInput = $("grace");
  const graceVal = $("graceVal");
  const sensSelect = $("sens");
  const workInput = $("workMin");
  const workVal = $("workVal");
  const breakInput = $("breakMin");
  const breakVal = $("breakVal");
  const cyclesInput = $("cyclesLong");
  const cyclesVal = $("cycleVal");
  const optSound = $("optSound");
  const optVibrate = $("optVibrate");
  const optVoice = $("optVoice");
  const todayFocus = $("todayFocus");
  const todayDist = $("todayDist");
  const totalDays = $("totalDays");
  const barsEl = $("bars");
  const landing = $("landing");
  const appSection = $("appSection");
  const enterBtn = $("enterBtn");
  const backBtn = $("backBtn");

  // ---------- 灵敏度阈值（v3 增强版） ----------
  // yaw: 头部左右偏转 / pitch: 头部俯仰 / gazeY: 视线向下 / score: 人脸检测分(遮挡) / minW: 脸大小 / ear: 闭眼
  const SENS = {
    loose:  { minW: 0.10, yaw: 0.19, pitch: 0.11, gazeY: 0.065, gazeX: 0.085, score: 0.55, ear: 0.11, centerY: 0.38 },
    normal: { minW: 0.14, yaw: 0.14, pitch: 0.075, gazeY: 0.05, gazeX: 0.06, score: 0.65, ear: 0.14, centerY: 0.32 },
    strict: { minW: 0.18, yaw: 0.09, pitch: 0.055, gazeY: 0.038, gazeX: 0.045, score: 0.75, ear: 0.17, centerY: 0.26 },
  };
  const LONG_BREAK_MIN = 15;

  // ---------- 状态 ----------
  let mode = "free";
  let session = null;
  let pomo = null;
  let distState = null;
  let modelsLoaded = false;
  let stream = null;
  let rafId = null;
  let detectTimer = null;
  let eyesClosedSince = 0;
  let handSince = 0;      // 疑似遮挡持续计时

  // ---------- 音频/提醒 ----------
  let audioCtx = null;
  function beep(high) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const seq = high
        ? [[988,.18],[0,.12],[988,.18],[0,.12],[1319,.45]]
        : [[880,.18],[0,.12],[880,.18],[0,.12],[1180,.4]];
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
    if (optSound.checked) beep(false);
    if (optVibrate.checked && navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
    if (optVoice.checked) speak("喂，别开小差，快回来学习");
    alertText.textContent = msg;
    alertOverlay.classList.remove("hidden");
  }

  // ---------- 几何工具 ----------
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  // ---------- 人脸分析（face-api 68 点） ----------
  // 68 点: 0-16 下颌, 17-26 眉, 27-35 鼻, 36-41 左眼, 42-47 右眼, 48-67 嘴
  function analyzeFace(detection, landmarks) {
    const pts = landmarks.positions;   // 视频像素坐标
    const box = detection.box;

    const nose = pts[30];                       // 鼻尖
    const jawL = pts[0], jawR = pts[16];        // 下颌两端（近似两耳）
    const eyeLC = mid(pts[36], pts[39]);        // 左眼中心(内外眼角中点)
    const eyeRC = mid(pts[42], pts[45]);        // 右眼中心
    const eyeM = mid(eyeLC, eyeRC);             // 双眼中心
    const faceW = dist(jawL, jawR) || 0.001;
    const faceH = box.height || 0.001;

    // 头部偏转 yaw：鼻尖相对下颌中点的横向偏移（归一化）
    const jawMid = mid(jawL, jawR);
    const yaw = (nose.x - jawMid.x) / faceW;
    // 头部俯仰 pitch：鼻尖相对双眼中心的纵向偏移（>0 = 低头）
    const pitch = (nose.y - eyeM.y) / faceH;

    // 视线方向（瞳孔位置估计）：眼中心相对内外眼角中点的偏移
    // 左眼: 外眼角36 内眼角39，眼睑点 37/38/41/40 的平均 ≈ 瞳孔
    const pupilL = {
      x: (pts[37].x + pts[38].x + pts[41].x + pts[40].x) / 4,
      y: (pts[37].y + pts[38].y + pts[41].y + pts[40].y) / 4,
    };
    const pupilR = {
      x: (pts[43].x + pts[44].x + pts[47].x + pts[46].x) / 4,
      y: (pts[43].y + pts[44].y + pts[47].y + pts[46].y) / 4,
    };
    const eyeLW = dist(pts[36], pts[39]) || 0.001;
    const eyeRW = dist(pts[42], pts[45]) || 0.001;
    const gazeX = ((pupilL.x - eyeLC.x) / eyeLW + (pupilR.x - eyeRC.x) / eyeRW) / 2;
    const gazeY = ((pupilL.y - eyeLC.y) / eyeLW + (pupilR.y - eyeRC.y) / eyeRW) / 2;

    // 眼睑开合 EAR
    const earL = (dist(pts[37], pts[41]) + dist(pts[38], pts[40])) / (2 * eyeLW);
    const earR = (dist(pts[43], pts[47]) + dist(pts[44], pts[46])) / (2 * eyeRW);
    const ear = (earL + earR) / 2;

    return { yaw, pitch, gazeX, gazeY, ear, box, nose, eyeLC, eyeRC, eyeM, pupilL, pupilR, score: detection.score };
  }

  // ---------- 检测循环 ----------
  async function detect() {
    if (!session || !session.running) return;
    try {
      const res = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }))
        .withFaceLandmarks();
      drawOverlay(res);
      evaluate(res);
    } catch (e) {}
  }

  function drawOverlay(res) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!res) return;
    const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
    const a = analyzeFace(res.detection, res.landmarks);
    const X = (x) => (1 - x / vw) * overlay.width;
    const Y = (y) => (y / vh) * overlay.height;

    // 人脸框
    ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 3;
    ctx.strokeRect(X(a.box.x + a.box.width), Y(a.box.y), (a.box.width / vw) * overlay.width, (a.box.height / vh) * overlay.height);

    // 眼睛 + 瞳孔 + 视线
    ctx.fillStyle = "#38bdf8";
    for (const p of [a.eyeLC, a.eyeRC]) { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#fbbf24";
    for (const p of [a.pupilL, a.pupilR]) { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 3.5, 0, Math.PI * 2); ctx.fill(); }
    // 视线延长线
    ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 2;
    for (const [p, c] of [[a.pupilL, a.eyeLC], [a.pupilR, a.eyeRC]]) {
      const dx = (p.x - c.x) * 6, dy = (p.y - c.y) * 6;
      ctx.beginPath();
      ctx.moveTo(X(p.x), Y(p.y));
      ctx.lineTo(X(p.x + dx), Y(p.y + dy));
      ctx.stroke();
    }
    // 头部姿态角度标签
    ctx.fillStyle = "#22c55e";
    ctx.font = "13px sans-serif";
    ctx.fillText(`yaw ${(a.yaw * 100).toFixed(0)}  pitch ${(a.pitch * 100).toFixed(0)}  gaze ${(a.gazeY * 100).toFixed(0)}`, 10, 20);
  }

  // ---------- 专注状态评估（v3 增强） ----------
  function evaluating() {
    return session && session.running && (mode !== "pomodoro" || (pomo && pomo.phase === "focus"));
  }

  function evaluate(res) {
    if (!evaluating()) {
      if (pomo && pomo.phase !== "focus") faceStatus.textContent = "☕ 休息中，放松一下";
      distState = null;
      return;
    }
    const s = SENS[sensSelect.value];
    const now = Date.now();
    const vw = video.videoWidth || 1;
    let reason = null;

    if (!res || !res.detection) {
      reason = "找不到你的脸（离开摄像头了？）";
    } else {
      const a = analyzeFace(res.detection, res.landmarks);
      const bw = a.box.width / vw;

      // 1. 脸太小 → 太远/凑近玩手机
      if (bw < s.minW) reason = "脸离得太远（低头玩手机？）";
      // 2. 检测分过低 → 手/手机挡住了脸
      else if (a.score < s.score) {
        if (!handSince) handSince = now;
        if (now - handSince > 1000) reason = "有东西挡住脸了——玩手机？📵";
      } else {
        handSince = 0;
        // 3. 头部俯仰 → 低头
        if (a.pitch > s.pitch) reason = "低头了——在看手机？📵";
        // 4. 头部偏转 → 转头
        else if (Math.abs(a.yaw) > s.yaw) reason = "头偏了，没看屏幕";
        // 5. 视线向下 → 眼神在看下面（手机）
        else if (a.gazeY > s.gazeY) reason = "眼神向下——在看手机？📵";
        // 6. 视线左右飘
        else if (Math.abs(a.gazeX) > s.gazeX) reason = "眼神飘了，看别处";
        // 7. 闭眼
        else if (a.ear < s.ear) {
          if (!eyesClosedSince) eyesClosedSince = now;
          if (now - eyesClosedSince > 1500) reason = "闭眼太久，困了？";
        } else eyesClosedSince = 0;
      }
      // 8. 脸位置过低（整体姿势）
      if (!reason) {
        const cy = (a.box.y + a.box.height / 2) / (video.videoHeight || 1);
        if (cy > 0.45 + s.centerY) reason = "整个人趴下去了？坐直！";
      }
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
      distState = { reason, since: now, alerted: false };
    }
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
      const dur = Math.round((now - distState.since) / 1000);
      session.distEvents.push({ t: new Date(distState.since), dur, reason: distState.reason });
      session.distMs += dur * 1000;
      log(`⚠️ ${fmtTime(distState.since)} 开小差 ${dur}s（${distState.reason}）`, "dist");
      alertOverlay.classList.add("hidden");
      if (optVoice.checked) speak("好，继续加油");
    }
    distState = null;
    stateDot.className = "state-dot focus";
    stateText.textContent = pomo && pomo.phase === "focus" ? "专注中" : "学习中";
  }

  // ---------- 每日统计 ----------
  const STORE_KEY = "sm_daily";
  function loadDaily() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
  function saveDaily(d) { try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (e) {} }
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function addStats(fSec, dSec, c) {
    const d = loadDaily();
    const k = dateKey(new Date());
    const cur = d[k] || { f: 0, d: 0, c: 0 };
    cur.f += Math.round(fSec); cur.d += Math.round(dSec); cur.c += c;
    d[k] = cur;
    saveDaily(d);
  }
  function renderStats() {
    const d = loadDaily();
    const today = d[dateKey(new Date())] || { f: 0, d: 0, c: 0 };
    todayFocus.textContent = Math.round(today.f / 60) + "分";
    todayDist.textContent = today.c + "次";
    totalDays.textContent = Object.keys(d).length + "天";
    const days = ["日", "一", "二", "三", "四", "五", "六"];
    const now = new Date();
    let maxF = 1;
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const rec = d[dateKey(dt)] || { f: 0 };
      arr.push({ dt, f: rec.f / 60, isToday: i === 0 });
      maxF = Math.max(maxF, rec.f / 60);
    }
    barsEl.innerHTML = "";
    arr.forEach(({ dt, f, isToday }) => {
      const col = document.createElement("div");
      col.className = "bar-col";
      const h = Math.max(3, Math.round((f / maxF) * 100));
      col.innerHTML =
        `<span class="bar-val">${f >= 1 ? Math.round(f) : ""}</span>` +
        `<div class="bar${isToday ? " today" : ""}" style="height:${h}%"></div>` +
        `<span class="bar-day">${isToday ? "今" : days[dt.getDay()]}</span>`;
      barsEl.appendChild(col);
    });
  }

  // ---------- 番茄钟 ----------
  function phaseMinutes(phase) {
    return phase === "focus" ? parseInt(workInput.value, 10)
      : phase === "long" ? LONG_BREAK_MIN
      : parseInt(breakInput.value, 10);
  }
  function enterPhase(phase) {
    pomo.phase = phase;
    pomo.phaseEndAt = Date.now() + phaseMinutes(phase) * 60000;
    if (phase === "focus") pomo.focusAtPhaseStart = session.focusMs;
    phaseTag.textContent = phase === "focus" ? "🔴 专注中" : phase === "long" ? "☕ 长休息" : "🟠 休息中";
    phaseTag.className = "phase-tag pop" + (phase === "break" ? " break" : phase === "long" ? " long" : "");
    timerEl.classList.remove("pulse");
    void timerEl.offsetWidth;
    timerEl.classList.add("pulse");
    stateText.textContent = phase === "focus" ? "专注中" : "休息中";
    stateDot.className = "state-dot" + (phase === "focus" ? " focus" : "");
    cycleText.textContent = phase === "focus" && pomo.cycle > 0 ? `第 ${pomo.cycle + 1} 轮` : "";
  }
  function finishFocusPhase() {
    const fDelta = session.focusMs - pomo.focusAtPhaseStart;
    addStats(fDelta, 0, 0);
    pomo.cycle++;
    const long = pomo.cycle % parseInt(cyclesInput.value, 10) === 0;
    const next = long ? "long" : "break";
    log(`🍅 专注 ${Math.round(fDelta / 60000 * 10) / 10} 分钟完成`, "focus");
    if (optSound.checked) beep(true);
    if (optVibrate.checked && navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if (optVoice.checked) speak(long ? "太棒了，休息十五分钟" : `休息${breakInput.value}分钟`);
    enterPhase(next);
    renderStats();
  }
  function finishBreakPhase() {
    if (optSound.checked) beep(true);
    if (optVoice.checked) speak("休息结束，继续加油");
    enterPhase("focus");
  }

  // ---------- 计时器 ----------
  function tick() {
    if (!session || !session.running) return;
    const now = Date.now();
    if (mode === "pomodoro") {
      if (pomo.phase === "focus") session.focusMs += now - session.lastTick;
      if (now >= pomo.phaseEndAt) {
        if (pomo.phase === "focus") finishFocusPhase();
        else finishBreakPhase();
        session.lastTick = Date.now();
      }
    } else {
      session.focusMs += now - session.lastTick;
    }
    session.lastTick = now;
    if (mode === "pomodoro") {
      timerEl.textContent = fmtDur(Math.max(0, pomo.phaseEndAt - now));
    } else {
      timerEl.textContent = fmtDur(session.focusMs + session.distMs);
    }
    const total = session.focusMs + session.distMs;
    focusPct.textContent = (total > 0 ? Math.round((session.focusMs / total) * 100) : 100) + "%";
    distCount.textContent = session.distEvents.length;
    distTime.textContent = Math.round(session.distMs / 1000) + "s";
    rafId = requestAnimationFrame(tick);
  }

  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0
      ? String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0")
      : String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
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
    if (!modelsLoaded) { faceStatus.textContent = "AI 模型加载中，稍等…"; return; }
    if (!stream) { faceStatus.textContent = "摄像头未就绪"; return; }
    session = {
      startedAt: Date.now(), focusMs: 0, distMs: 0,
      distEvents: [], lastTick: Date.now(), running: true,
    };
    distState = null; eyesClosedSince = 0; handSince = 0;
    if (mode === "pomodoro") {
      pomo = { phase: "focus", phaseEndAt: Date.now() + phaseMinutes("focus") * 60000, cycle: 0, focusAtPhaseStart: 0 };
      phaseTag.classList.remove("hidden");
      enterPhase("focus");
    } else {
      pomo = null;
      phaseTag.classList.add("hidden");
      stateText.textContent = "学习中";
      stateDot.className = "state-dot focus";
      cycleText.textContent = "";
    }
    startBtn.disabled = true;
    stopBtn.disabled = false;
    modeFree.disabled = true;
    modePomodoro.disabled = true;
    logList.innerHTML = '<li class="empty">开始记录…</li>';
    log(`📖 ${fmtTime(new Date())} 开始学习（${mode === "pomodoro" ? "番茄钟" : "自由模式"}）`, "focus");
    detectTimer = setInterval(detect, 350);
    rafId = requestAnimationFrame(tick);
  }

  function stopSession() {
    if (!session) return;
    session.running = false;
    clearInterval(detectTimer);
    cancelAnimationFrame(rafId);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    alertOverlay.classList.add("hidden");
    const fDelta = mode === "pomodoro" ? session.focusMs - pomo.focusAtPhaseStart : session.focusMs;
    addStats(fDelta, session.distMs, session.distEvents.length);
    const total = session.focusMs + session.distMs;
    const pct = total > 0 ? Math.round((session.focusMs / total) * 100) : 100;
    log(`🏁 ${fmtTime(new Date())} 结束，共 ${fmtDur(total)}，专注 ${pct}%`, "focus");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    modeFree.disabled = false;
    modePomodoro.disabled = false;
    stateDot.className = "state-dot";
    stateText.textContent = "已结束";
    cycleText.textContent = "";
    timerEl.textContent = "00:00";
    faceStatus.textContent = "已结束，休息一下吧";
    phaseTag.classList.add("hidden");
    session = null; distState = null; pomo = null;
    renderStats();
  }

  // ---------- 落地页过渡 ----------
  function enterApp() {
    landing.classList.add("landing-leave");
    setTimeout(() => {
      landing.style.display = "none";
      appSection.classList.remove("app-hidden");
      appSection.classList.add("app-show");
      window.scrollTo(0, 0);
      setTimeout(() => { overlay.width = video.clientWidth; overlay.height = video.clientHeight; }, 600);
    }, 450);
  }
  function backHome() {
    if (session && session.running) stopSession();
    appSection.classList.remove("app-show");
    appSection.classList.add("app-hidden");
    landing.style.display = "";
    landing.classList.remove("landing-leave");
    landing.querySelectorAll(".anim-up").forEach((el) => {
      el.style.animation = "none";
      void el.offsetWidth;
      el.style.animation = "";
    });
  }

  // ---------- 模式切换 ----------
  function setMode(m) {
    if (session && session.running) return;
    mode = m;
    modeFree.classList.toggle("active", m === "free");
    modePomodoro.classList.toggle("active", m === "pomodoro");
    timerEl.textContent = "00:00";
    faceStatus.textContent = m === "pomodoro" ? `番茄钟：专注${workInput.value}分 / 休${breakInput.value}分` : "就绪，点「开始学习」";
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
  enterBtn.onclick = enterApp;
  backBtn.onclick = backHome;
  modeFree.onclick = () => setMode("free");
  modePomodoro.onclick = () => setMode("pomodoro");
  alertBtn.onclick = () => {
    alertOverlay.classList.add("hidden");
    if (session && session.running) { markFocused(); distState = null; }
  };
  graceInput.oninput = () => (graceVal.textContent = graceInput.value);
  workInput.oninput = () => (workVal.textContent = workInput.value);
  breakInput.oninput = () => (breakVal.textContent = breakInput.value);
  cyclesInput.oninput = () => (cyclesVal.textContent = cyclesInput.value);

  renderStats();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  init();
})();
