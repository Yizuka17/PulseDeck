(() => {
  let lastPacketAt = 0;
  let pendingData = null;

  const byId = (id) => document.getElementById(id);
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
    byId("clockTime").textContent = now.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
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
    }
  });
  updateClock();
  setInterval(updateClock, 1000);
  connect();
})();
