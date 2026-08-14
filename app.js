// ============================================================
// 专注监督 · Study Monitor
// 摄像头人脸检测 + 姿态判断 + 番茄钟 + 每日统计
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

  // ---------- 灵敏度阈值 ----------
  const SENS = {
    loose:  { centerX: 0.35, centerY: 0.38, minW: 0.12, ear: 0.12 },
    normal: { centerX: 0.28, centerY: 0.32, minW: 0.16, ear: 0.15 },
    strict: { centerX: 0.20, centerY: 0.26, minW: 0.20, ear: 0.18 },
  };
  const LONG_BREAK_MIN = 15;

  // ---------- 状态 ----------
  let mode = "free";            // free | pomodoro
  let session = null;           // {running, startedAt, focusMs, distMs, distEvents, lastTick, mode}
  let pomo = null;              // {phase, phaseEndAt, cycle, focusAtPhaseStart}
  let distState = null;         // 开小差检测状态
  let modelsLoaded = false;
  let stream = null;
  let rafId = null;
  let detectTimer = null;

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
  function eyeAspectRatio(pts) {
    const L = [
      (dist(pts[37], pts[41]) + dist(pts[38], pts[40])) / (2 * dist(pts[36], pts[39])),
      (dist(pts[43], pts[47]) + dist(pts[44], pts[46])) / (2 * dist(pts[42], pts[45])),
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
    } catch (e) {}
  }

  function drawOverlay(res) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!res) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const box = res.detection.box;
    const bw = box.width / vw, bh = box.height / vh;
    const bx = box.x / vw, by = box.y / vh;
    const X = (x) => (1 - x) * overlay.width;
    const Y = (y) => y * overlay.height;
    ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 3;
    ctx.strokeRect(X(bx + bw), Y(by), bw * overlay.width, bh * overlay.height);
    ctx.fillStyle = "#38bdf8";
    const pts = res.landmarks.positions;
    for (const i of [...Array(6).keys()].map(k => k + 36).concat([...Array(6).keys()].map(k => k + 42))) {
      ctx.beginPath();
      ctx.arc(X(pts[i].x / vw), Y(pts[i].y / vh), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- 是否处于监督状态 ----------
  function supervising() {
    return session && session.running && (mode !== "pomodoro" || pomo.phase === "focus");
  }

  // ---------- 专注状态评估 ----------
  function evaluate(res) {
    if (!supervising()) {
      if (pomo && pomo.phase !== "focus") {
        faceStatus.textContent = "☕ 休息中，放松一下";
      }
      distState = null;
      return;
    }
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
        distState = distState || {};
        distState.closedSince = distState.closedSince || Date.now();
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

  // ---------- 每日统计 (localStorage) ----------
  const STORE_KEY = "sm_daily";
  function loadDaily() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveDaily(d) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (e) {}
  }
  function dateKey(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
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

    // 近 7 天柱状图
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

  // ---------- 番茄钟阶段 ----------
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
    void timerEl.offsetWidth; // 重启动画
    timerEl.classList.add("pulse");
    stateText.textContent = phase === "focus" ? "专注中" : "休息中";
    stateDot.className = "state-dot" + (phase === "focus" ? " focus" : "");
    cycleText.textContent = phase === "focus" && pomo.cycle > 0 ? `第 ${pomo.cycle + 1} 轮` : "";
  }

  function finishFocusPhase() {
    // 结算本阶段数据
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

    // 计时显示
    if (mode === "pomodoro") {
      const left = Math.max(0, pomo.phaseEndAt - now);
      timerEl.textContent = fmtDur(left);
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
    if (!modelsLoaded) { faceStatus.textContent = "模型还没加载完，稍等…"; return; }
    if (!stream) { faceStatus.textContent = "摄像头未就绪"; return; }

    session = {
      startedAt: Date.now(), focusMs: 0, distMs: 0,
      distEvents: [], lastTick: Date.now(), running: true,
    };
    distState = null;

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

    detectTimer = setInterval(detect, 400);
    rafId = requestAnimationFrame(tick);
  }

  function stopSession() {
    if (!session) return;
    session.running = false;
    clearInterval(detectTimer);
    cancelAnimationFrame(rafId);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    alertOverlay.classList.add("hidden");

    // 结算统计
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

  // ---------- 落地页与应用页过渡 ----------
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
  const MODELS_URL = "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v1.3/models";
  async function loadModels() {
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL);
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL);
    } catch (e) {
      // CDN 不可用时回退到本地相对路径
      await faceapi.nets.tinyFaceDetector.loadFromUri("models");
      await faceapi.nets.faceLandmark68Net.loadFromUri("models");
    }
  }

  async function init() {
    connBadge.textContent = "加载模型…";
    try {
      await loadModels();
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

  // 注册 Service Worker（PWA 离线能力）
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  init();
})();
