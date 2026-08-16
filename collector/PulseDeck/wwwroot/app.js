(() => {
  let lastPacketAt = 0;
  let pendingData = null;
  const fpsHistory = [];
  const maxFpsPoints = 48;
  let fpsResizeTimer = 0;

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

  function update(data) {
    lastPacketAt = Date.now();
    pendingData = data;
    if (document.hidden) return;
    byId("machineName").textContent = data.machineName || "此设备";
    byId("cpuName").textContent = data.cpuName || "Windows CPU";
    byId("gpuName").textContent = data.gpuName || "Windows GPU";
    byId("timestamp").textContent = new Date(data.timestamp || Date.now()).toLocaleTimeString("zh-CN", { hour12: false });
    byId("sourceStatus").textContent = data.error || (data.sourceFresh ? "传感器已同步" : "传感器数据可能已暂停");
    byId("gameState").textContent = data.gameActive ? "RTSS 正在捕获游戏" : "等待 RTSS 捕获游戏";

    setTextFields(data);
    setResource("ram", data.ramUsedMb, data.ramTotalMb);
    setResource("vram", data.gpuMemoryUsedMb, data.gpuMemoryTotalMb);
    byId("networkDown").textContent = formatSpeed(data.networkDownloadBytesPerSecond);
    byId("networkUp").textContent = formatSpeed(data.networkUploadBytesPerSecond);

    const cpuUsage = finite(data.cpuUsagePercent) ? clamp(data.cpuUsagePercent, 0, 100) : 0;
    const gpuUsage = finite(data.gpuUsagePercent) ? clamp(data.gpuUsagePercent, 0, 100) : 0;
    byId("cpuRing").style.setProperty("--value", cpuUsage.toFixed(1));
    byId("gpuRing").style.setProperty("--value", gpuUsage.toFixed(1));
    updateFpsChart(data.gameActive ? data.framerate : null);

    if (data.afterburnerConnected && data.sourceFresh) setConnection("live", "实时");
    else if (data.afterburnerConnected) setConnection("waiting", "已暂停");
    else setConnection("error", "离线");
  }

  const clockAngles = { hour: null, minute: null, second: null };

  function forwardClockAngle(hand, angle) {
    const previous = clockAngles[hand];
    while (previous !== null && angle < clockAngles[hand]) angle += 360;
    clockAngles[hand] = angle;
    return angle;
  }

  function setFlipDigit(id, value) {
    const digit = byId(id);
    const previous = digit.dataset.value;
    if (previous === value) return;
    digit.dataset.previous = previous || value;
    digit.dataset.value = value;
    digit.textContent = value;
    if (!previous) return;
    digit.classList.remove("is-flipping");
    requestAnimationFrame(() => digit.classList.add("is-flipping"));
  }

  function updateClock() {
    if (document.hidden) return;
    const now = new Date();
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
    byId("clockDate").textContent = now.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short"
    }).replace(/(日)(周)/, "$1 · $2");
  }

  async function fetchOnce() {
    try {
      const response = await fetch("/api/metrics", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      update(await response.json());
    } catch {
      if (Date.now() - lastPacketAt > 2500) setConnection("error", "连接断开");
    }
  }

  function connect() {
    if (!("EventSource" in window)) {
      fetchOnce();
      setInterval(fetchOnce, 1000);
      return;
    }

    const events = new EventSource("/api/stream");
    events.onmessage = (event) => {
      try { update(JSON.parse(event.data)); } catch { /* wait for next complete event */ }
    };
    events.onerror = () => {
      if (Date.now() - lastPacketAt > 2500) setConnection("error", "正在重连");
    };
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      updateClock();
      if (pendingData) update(pendingData);
      else updateFpsChart(null, false);
    }
  });
  window.addEventListener("resize", () => {
    clearTimeout(fpsResizeTimer);
    fpsResizeTimer = window.setTimeout(() => updateFpsChart(null, false), 140);
  }, { passive: true });
  updateClock();
  setInterval(updateClock, 1000);
  connect();
})();
