// ============================================================
// 专注监督 · Study Monitor (v2.0 - MediaPipe AI 引擎)
// Google MediaPipe：478 点人脸 + 虹膜视线追踪 + 手部识别
// 能识别：低头看手机、眼神飘走、闭眼、手拿手机等动作
// 所有画面只在本地浏览器处理，不上传任何数据
// ============================================================

import { FilesetResolver, FaceLandmarker, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

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

  // ---------- 灵敏度阈值（MediaPipe 版） ----------
  const SENS = {
    loose:  { minW: 0.10, yaw: 0.22, gazeX: 0.10, gazeY: 0.11, ear: 0.11, hand: 2.0, centerY: 0.38 },
    normal: { minW: 0.14, yaw: 0.16, gazeX: 0.075, gazeY: 0.085, ear: 0.14, hand: 1.6, centerY: 0.32 },
    strict: { minW: 0.18, yaw: 0.11, gazeX: 0.055, gazeY: 0.065, ear: 0.17, hand: 1.25, centerY: 0.26 },
  };
  const LONG_BREAK_MIN = 15;

  // ---------- 状态 ----------
  let mode = "free";
  let session = null;
  let pomo = null;
  let distState = null;
  let modelsLoaded = false;
  let stream = null;
  let faceL = null, handL = null;
  let rafId = null;
  let detectTimer = null;
  let lastHandAt = 0;
  let handSince = 0;       // 手持续出现在脸前的起始时间
  let eyesClosedSince = 0; // 持续闭眼起始时间

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
  const P = (lm, i) => ({ x: lm[i].x, y: lm[i].y });
  function d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  // ---------- 人脸分析（478 点） ----------
  function analyzeFace(lm) {
    // 关键点（478 点模型）
    const nose = P(lm, 1);
    const earL = P(lm, 234), earR = P(lm, 454);
    const fore = P(lm, 10), chin = P(lm, 152);
    // 眼睛
    const eyeLO = P(lm, 33), eyeLI = P(lm, 133);   // 左眼外/内角
    const eyeRO = P(lm, 362), eyeRI = P(lm, 263);  // 右眼外/内角
    // 虹膜中心（视线追踪）
    const irisL = P(lm, 468), irisR = P(lm, 473);
    // 眼睑（EAR 眨眼检测）
    const lUp1 = P(lm, 159), lUp2 = P(lm, 158), lLo1 = P(lm, 145), lLo2 = P(lm, 153);
    const rUp1 = P(lm, 386), rUp2 = P(lm, 385), rLo1 = P(lm, 374), rLo2 = P(lm, 380);

    // 人脸包围盒
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of lm) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const faceW = maxX - minX, faceH = maxY - minY;
    const faceCx = (minX + maxX) / 2, faceCy = (minY + maxY) / 2;
    const earMid = mid(earL, earR);

    // 头部偏转（鼻尖相对两耳中点）
    const yaw = (nose.x - earMid.x) / (faceW || 0.001);
    // 头部俯仰（鼻尖相对耳中点纵向）
    const pitch = (nose.y - earMid.y) / (faceH || 0.001);

    // 视线：虹膜相对眼角的偏移（归一化）
    const eyeLW = d(eyeLO, eyeLI) || 0.001;
    const eyeRW = d(eyeRO, eyeRI) || 0.001;
    const eyeLC = mid(eyeLO, eyeLI), eyeRC = mid(eyeRO, eyeRI);
    const gazeX = ((irisL.x - eyeLC.x) / eyeLW + (irisR.x - eyeRC.x) / eyeRW) / 2;
    const gazeY = ((irisL.y - eyeLC.y) / eyeLW + (irisR.y - eyeRC.y) / eyeRW) / 2;

    // 眼睑开合度 EAR
    const earLv = (d(lUp1, lLo1) + d(lUp2, lLo2)) / (2 * eyeLW);
    const earRv = (d(rUp1, rLo1) + d(rUp2, rLo2)) / (2 * eyeRW);
    const ear = (earLv + earRv) / 2;

    return {
      box: { x: minX, y: minY, w: faceW, h: faceH },
      cx: faceCx, cy: faceCy, yaw, pitch,
      gazeX, gazeY, ear,
      eyes: { eyeLO, eyeLI, eyeRO, eyeRI, irisL, irisR },
    };
  }

  // ---------- 检测循环（MediaPipe） ----------
  async function detect() {
    if (!session || !session.running || !faceL || !handL) return;
    const t = performance.now();
    let fRes = null, hRes = null;
    try {
      fRes = faceL.detectForVideo(video, t);
      if (t - lastHandAt > 350) { // 手部检测隔帧执行，省 CPU
        hRes = handL.detectForVideo(video, t);
        lastHandAt = t;
      }
    } catch (e) {}
    drawOverlay(fRes, hRes);
    evaluate(fRes, hRes);
  }

  function drawOverlay(fRes, hRes) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const X = (x) => (1 - x) * overlay.width;
    const Y = (y) => y * overlay.height;

    if (fRes && fRes.faceLandmarks && fRes.faceLandmarks[0]) {
      const lm = fRes.faceLandmarks[0];
      const a = analyzeFace(lm);
      // 人脸框
      ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 3;
      ctx.strokeRect(X(a.box.x + a.box.w), Y(a.box.y), a.box.w * overlay.width, a.box.h * overlay.height);
      // 眼睛 + 虹膜
      const es = a.eyes;
      ctx.fillStyle = "#38bdf8";
      for (const p of [es.eyeLO, es.eyeLI, es.eyeRO, es.eyeRI]) {
        ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#fbbf24"; // 虹膜金色
      for (const p of [es.irisL, es.irisR]) {
        ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 3.5, 0, Math.PI * 2); ctx.fill();
      }
      // 视线方向指示
      const gcx = X(es.irisL.x) - (a.gazeX * 40);
      const gcy = Y(es.irisL.y) - (a.gazeY * 40);
      ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(es.irisL.x), Y(es.irisL.y));
      ctx.lineTo(gcx, gcy);
      ctx.stroke();
    }

    if (hRes && hRes.landmarks && hRes.landmarks.length) {
      // 手部骨架
      const CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
      ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2.5;
      for (const hand of hRes.landmarks) {
        for (const [i, j] of CONN) {
          ctx.beginPath();
          ctx.moveTo(X(hand[i].x), Y(hand[i].y));
          ctx.lineTo(X(hand[j].x), Y(hand[j].y));
          ctx.stroke();
        }
      }
    }
  }

  // ---------- 专注状态评估 ----------
  function evaluating() {
    return session && session.running && (mode !== "pomodoro" || (pomo && pomo.phase === "focus"));
  }

  function evaluate(fRes, hRes) {
    if (!evaluating()) {
      if (pomo && pomo.phase !== "focus") faceStatus.textContent = "☕ 休息中，放松一下";
      distState = null;
      return;
    }
    const s = SENS[sensSelect.value];
    const now = Date.now();
    const vw = video.videoWidth || 1;
    let reason = null;
    let handNear = false;

    // 手部：手在脸附近？
    let handBox = null;
    if (hRes && hRes.landmarks && hRes.landmarks.length) {
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const h of hRes.landmarks) for (const p of h) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
      handBox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    if (!fRes || !fRes.faceLandmarks || !fRes.faceLandmarks[0]) {
      reason = "找不到你的脸（离开摄像头了？）";
    } else {
      const a = analyzeFace(fRes.faceLandmarks[0]);

      if (a.box.w < s.minW) reason = "脸离得太远（低头玩手机？）";
      else if (Math.abs(a.yaw) > s.yaw) reason = a.yaw > 0 ? "头偏了，没看屏幕" : "头偏了，没看屏幕";
      else if (a.cy > 0.45 + s.centerY) reason = "低头了（脸太靠下）";
      else if (a.gazeY > s.gazeY) reason = "视线朝下——在看手机？📵";
      else if (Math.abs(a.gazeX) > s.gazeX) reason = "眼神飘了，看别处";
      else if (a.ear < s.ear) {
        if (!eyesClosedSince) eyesClosedSince = now;
        if (now - eyesClosedSince > 1500) reason = "闭眼太久，困了？";
      } else eyesClosedSince = 0;

      // 手在脸附近判定（脸区域外扩 s.hand 倍）
      if (!reason && handBox) {
        const fx = a.box.x, fy = a.box.y, fw = a.box.w, fh = a.box.h;
        const inflate = s.hand;
        const region = {
          x: fx - fw * (inflate - 1) / 2,
          y: fy - fh * (inflate - 1) / 2,
          w: fw * inflate,
          h: fh * inflate * 1.4,
        };
        const hc = { x: handBox.x + handBox.w / 2, y: handBox.y + handBox.h / 2 };
        if (hc.x > region.x && hc.x < region.x + region.w && hc.y > region.y && hc.y < region.y + region.h) {
          handNear = true;
          if (!handSince) handSince = now;
          if (now - handSince > 1200) reason = "手在脸前——玩手机？📵";
        } else handSince = 0;
      }
      if (!handNear) handSince = 0;
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
    detectTimer = setInterval(detect, 300);
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

  // ---------- 初始化（MediaPipe 模型） ----------
  const MODEL_BASE = "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v2.0/models";
  // 带超时的加载（防止卡死）
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + " 超时")), ms)),
    ]);
  }
  async function loadModels() {
    connBadge.textContent = "加载 AI 模型…";
    connBadge.className = "badge warn";
    const vision = await withTimeout(
      FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      ),
      60000, "wasm"
    );
    // CPU 委托：兼容性最好，手机端速度足够（检测间隔 300ms）
    connBadge.textContent = "加载人脸模型…";
    faceL = await withTimeout(
      FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${MODEL_BASE}/face_landmarker.task`, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
      }),
      120000, "人脸模型"
    );
    connBadge.textContent = "加载手部模型…";
    handL = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${MODEL_BASE}/hand_landmarker.task`, delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 2,
      }),
      120000, "手部模型"
    );
    modelsLoaded = true;
    connBadge.textContent = "AI 就绪";
    connBadge.className = "badge ok";
  }

  async function init() {
    try {
      await loadModels();
      faceStatus.textContent = "AI 模型就绪，请允许摄像头权限";
    } catch (e) {
      connBadge.textContent = "模型加载失败";
      connBadge.className = "badge err";
      faceStatus.textContent = "AI 模型加载失败，检查网络后刷新";
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
