(() => {
  let lastPacketAt = 0;
  let lastSsePacketAt = 0;
  let lastWatchdogRecoveryAt = 0;
  let pendingData = null;
  const fpsHistory = [];
  const maxFpsPoints = 48;
  let fpsResizeTimer = 0;
  let eventSource = null;
  let streamReconnectTimer = 0;
  let streamReconnectAttempts = 0;
  let fallbackPollingTimer = 0;

  const byId = (id) => document.getElementById(id);
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
  const themeStorageKey = "pulse-deck-theme";
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  let selectedTheme = "auto";

  function resolvedTheme(choice) {
    return choice === "auto" ? (systemTheme.matches ? "dark" : "light") : choice;
  }

  function applyTheme(choice, persist = true) {
    selectedTheme = ["auto", "light", "dark"].includes(choice) ? choice : "auto";
    const theme = resolvedTheme(selectedTheme);
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#18141c" : "#f7f2fa");
    themeButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeChoice === selectedTheme));
    });
    if (persist) {
      try { localStorage.setItem(themeStorageKey, selectedTheme); } catch { /* Storage is optional. */ }
    }
  }

  try { applyTheme(localStorage.getItem(themeStorageKey) || "auto", false); }
  catch { applyTheme("auto", false); }
  themeButtons.forEach((button) => button.addEventListener("click", () => applyTheme(button.dataset.themeChoice)));
  systemTheme.addEventListener("change", () => {
    if (selectedTheme === "auto") applyTheme("auto", false);
  });

  const decimalsFor = (field) => {
    if (field.includes("Temperature")) return 0;
    if (field.includes("Clock")) return 0;
    if (field === "frametimeMs") return 2;
    return 1;
  };

  const formatNumber = (value, decimals = 1) => finite(value)
    ? value.toLocaleString("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : "—";

  const formatSpeed = (bytes) => {
    if (!finite(bytes)) return "—";
    if (bytes >= 1024 * 1024) return `${formatNumber(bytes / 1024 / 1024, 2)} MB/s`;
    if (bytes >= 1024) return `${formatNumber(bytes / 1024, 1)} KB/s`;
    return `${formatNumber(bytes, 0)} B/s`;
  };

  function setConnection(kind, text) {
    const state = byId("connectionState");
    state.classList.toggle("is-waiting", kind === "waiting");
    state.classList.toggle("is-error", kind === "error");
    state.querySelector("span").textContent = text;
  }

  function setTextFields(data) {
    document.querySelectorAll("[data-field]").forEach((node) => {
      const field = node.dataset.field;
      let value = data[field];
      if (node.dataset.format === "ghz" && finite(value)) value /= 1000;
      const decimals = node.dataset.format === "ghz" ? 2 : decimalsFor(field);
      node.textContent = formatNumber(value, decimals);
    });
  }

  function setResource(prefix, usedMb, totalMb) {
    const used = finite(usedMb) ? usedMb / 1024 : null;
    const total = finite(totalMb) ? totalMb / 1024 : null;
    const percent = finite(used) && finite(total) && total > 0 ? clamp(used / total * 100, 0, 100) : 0;
    byId(`${prefix}Used`).textContent = formatNumber(used, 1);
    byId(`${prefix}Total`).textContent = formatNumber(total, 1);
    byId(`${prefix}Percent`).textContent = formatNumber(percent, 0);
    byId(`${prefix}Progress`).style.width = `${percent}%`;
  }

  function updateFpsChart(value, append = true) {
    if (append) {
      fpsHistory.push(finite(value) && value > 0 ? value : null);
      if (fpsHistory.length > maxFpsPoints) fpsHistory.shift();
    }

    const canvas = byId("fpsChart");
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 2 || height < 2) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    const values = fpsHistory.filter(finite);
    if (values.length < 2) return;

    const maximum = Math.max(60, ...values);
    const padding = 3;
    const points = fpsHistory
      .map((fps, index) => ({ fps, index }))
      .filter(point => finite(point.fps))
      .map(point => ({
        x: padding + point.index / Math.max(1, maxFpsPoints - 1) * (width - padding * 2),
        y: height - padding - point.fps / Math.max(1, maximum) * (height - padding * 2)
      }));

    const traceCurve = () => {
      context.beginPath();
      points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else {
          const previous = points[index - 1];
          context.quadraticCurveTo((previous.x + point.x) / 2, previous.y, point.x, point.y);
        }
      });
    };

    traceCurve();
    context.lineTo(points.at(-1).x, height);
    context.lineTo(points[0].x, height);
    context.closePath();
    context.fillStyle = "#b8f2c925";
    context.fill();

    traceCurve();
    context.strokeStyle = "#b8f2c9";
    context.lineWidth = 2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
  }

  function update(data, source = "http") {
    if (source !== "cached") {
      lastPacketAt = Date.now();
      if (source === "sse") {
        lastSsePacketAt = lastPacketAt;
        stopFallbackPolling();
      }
    }
    pendingData = data;
    if (document.hidden) return;
    byId("cpuName").textContent = data.cpuName || "Windows CPU";
    byId("gpuName").textContent = data.gpuName || "Windows GPU";
    byId("sourceStatus").textContent = "传感器已同步";
    const gameActive = finite(data.framerate) && data.framerate > 0.01;
    byId("gameState").textContent = gameActive ? "RTSS 正在捕获游戏" : "等待 RTSS 捕获游戏";

    setTextFields(data);
    setResource("ram", data.ramUsedMb, data.ramTotalMb);
    setResource("vram", data.gpuMemoryUsedMb, data.gpuMemoryTotalMb);
    byId("networkDown").textContent = formatSpeed(data.networkDownloadBytesPerSecond);
    byId("networkUp").textContent = formatSpeed(data.networkUploadBytesPerSecond);

    const cpuUsage = finite(data.cpuUsagePercent) ? clamp(data.cpuUsagePercent, 0, 100) : 0;
    const gpuUsage = finite(data.gpuUsagePercent) ? clamp(data.gpuUsagePercent, 0, 100) : 0;
    byId("cpuRing").style.setProperty("--value", cpuUsage.toFixed(1));
    byId("gpuRing").style.setProperty("--value", gpuUsage.toFixed(1));
    updateFpsChart(gameActive ? data.framerate : null);
    if (source === "sse" || !("EventSource" in window)) setConnection("live", "实时");
    else if (source === "http" && fallbackPollingTimer) setConnection("waiting", "HTTP 保活");
  }

  const clockAngles = { hour: null, minute: null, second: null };

  function forwardClockAngle(hand, angle) {
    const previous = clockAngles[hand];
    while (previous !== null && angle < clockAngles[hand]) angle += 360;
    clockAngles[hand] = angle;
    return angle;
  }

  function getFlipLayers(digit) {
    if (digit._flipLayers) return digit._flipLayers;
    digit.innerHTML = `
      <span class="flip-half flip-static flip-static-top"><span class="flip-glyph"></span></span>
      <span class="flip-half flip-static flip-static-bottom"><span class="flip-glyph"></span></span>
      <span class="flip-half flip-leaf flip-leaf-top"><span class="flip-glyph"></span></span>
      <span class="flip-half flip-leaf flip-leaf-bottom"><span class="flip-glyph"></span></span>`;
    digit._flipLayers = {
      staticTop: digit.querySelector(".flip-static-top .flip-glyph"),
      staticBottom: digit.querySelector(".flip-static-bottom .flip-glyph"),
      leafTop: digit.querySelector(".flip-leaf-top .flip-glyph"),
      leafBottom: digit.querySelector(".flip-leaf-bottom .flip-glyph"),
      bottomLeaf: digit.querySelector(".flip-leaf-bottom")
    };
    return digit._flipLayers;
  }

  function setFlipDigit(id, value) {
    const digit = byId(id);
    const previous = digit.dataset.value;
    if (previous === value) return;

    const layers = getFlipLayers(digit);
    digit.dataset.value = value;
    if (!previous) {
      layers.staticTop.textContent = value;
      layers.staticBottom.textContent = value;
      layers.leafTop.textContent = value;
      layers.leafBottom.textContent = value;
      return;
    }

    digit.classList.remove("is-flipping");
    layers.staticTop.textContent = value;
    layers.staticBottom.textContent = previous;
    layers.leafTop.textContent = previous;
    layers.leafBottom.textContent = value;
    void digit.offsetWidth;
    layers.bottomLeaf.addEventListener("animationend", () => {
      if (digit.dataset.value !== value) return;
      layers.staticBottom.textContent = value;
      digit.classList.remove("is-flipping");
    }, { once: true });
    requestAnimationFrame(() => digit.classList.add("is-flipping"));
  }

  function updateClock() {
    if (document.hidden) return;
    const now = new Date();
    byId("timestamp").textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const milliseconds = now.getMilliseconds();
    const hourAngle = forwardClockAngle("hour", (hours % 12) * 30 + minutes * 0.5 + seconds / 120);
    const minuteAngle = forwardClockAngle("minute", minutes * 6 + seconds * 0.1 + milliseconds / 10000);
    const secondAngle = forwardClockAngle("second", seconds * 6 + milliseconds * 0.006);

    byId("clockHour").style.transform = `translateX(-50%) rotate(${hourAngle}deg)`;
    byId("clockMinute").style.transform = `translateX(-50%) rotate(${minuteAngle}deg)`;
    byId("clockSecond").style.transform = `translateX(-50%) rotate(${secondAngle}deg)`;
    const timeParts = [hours, minutes, seconds].map(value => String(value).padStart(2, "0"));
    setFlipDigit("clockHourTens", timeParts[0][0]);
    setFlipDigit("clockHourOnes", timeParts[0][1]);
    setFlipDigit("clockMinuteTens", timeParts[1][0]);
    setFlipDigit("clockMinuteOnes", timeParts[1][1]);
    setFlipDigit("clockSecondTens", timeParts[2][0]);
    setFlipDigit("clockSecondOnes", timeParts[2][1]);
    byId("clockTime").setAttribute("aria-label", `当前时间 ${timeParts.join(":")}`);
    byId("clockDate").textContent = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map(value => String(value).padStart(2, "0"))
      .join("/");
  }

  async function fetchOnce() {
    try {
      const response = await fetch("/api/metrics", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      update(await response.json(), "http");
    } catch {
      if (Date.now() - lastPacketAt > 2500) setConnection("error", "连接断开");
    }
  }

  function stopEventStream() {
    window.clearTimeout(streamReconnectTimer);
    streamReconnectTimer = 0;
    if (!eventSource) return;
    eventSource.onopen = null;
    eventSource.onmessage = null;
    eventSource.onerror = null;
    eventSource.close();
    eventSource = null;
  }

  function stopFallbackPolling() {
    window.clearInterval(fallbackPollingTimer);
    fallbackPollingTimer = 0;
  }

  function startFallbackPolling() {
    if (fallbackPollingTimer) return;
    fetchOnce();
    fallbackPollingTimer = window.setInterval(fetchOnce, 1000);
  }

  function scheduleStreamReconnect() {
    if (document.hidden || streamReconnectTimer) return;
    const delay = Math.min(5000, 500 * 2 ** streamReconnectAttempts++);
    streamReconnectTimer = window.setTimeout(() => {
      streamReconnectTimer = 0;
      connect();
    }, delay);
  }

  function connect() {
    if (!("EventSource" in window)) {
      startFallbackPolling();
      return;
    }

    stopEventStream();
    lastSsePacketAt = Date.now();
    const stream = new EventSource("/api/stream");
    eventSource = stream;
    stream.onopen = () => {
      if (eventSource === stream) streamReconnectAttempts = 0;
    };
    stream.onmessage = (event) => {
      try { update(JSON.parse(event.data), "sse"); } catch { /* wait for next complete event */ }
    };
    stream.onerror = () => {
      if (eventSource !== stream) return;
      stream.close();
      eventSource = null;
      lastSsePacketAt = 0;
      startFallbackPolling();
      if (Date.now() - lastPacketAt > 2500) setConnection("error", "正在重连");
      scheduleStreamReconnect();
    };
  }

  function runStreamWatchdog() {
    if (document.hidden || !("EventSource" in window)) return;
    const now = Date.now();
    if (now - lastSsePacketAt <= 4000) return;

    // A tunnel or mobile browser can leave EventSource open without delivering
    // an error. Keep the UI fresh over HTTP, then replace that stale stream.
    startFallbackPolling();
    if (now - lastWatchdogRecoveryAt < 4000) return;
    lastWatchdogRecoveryAt = now;
    setConnection("waiting", "正在恢复数据");
    connect();
  }

  function resumeRealtimeMetrics() {
    streamReconnectAttempts = 0;
    if ("EventSource" in window) {
      fetchOnce();
      connect();
    } else {
      connect();
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopEventStream();
      stopFallbackPolling();
      return;
    }
    updateClock();
    if (pendingData) update(pendingData, "cached");
    else updateFpsChart(null, false);
    resumeRealtimeMetrics();
  });
  window.addEventListener("pagehide", () => {
    stopEventStream();
    stopFallbackPolling();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !document.hidden) resumeRealtimeMetrics();
  });
  window.addEventListener("resize", () => {
    clearTimeout(fpsResizeTimer);
    fpsResizeTimer = window.setTimeout(() => updateFpsChart(null, false), 140);
  }, { passive: true });
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(runStreamWatchdog, 2000);
  connect();
})();
