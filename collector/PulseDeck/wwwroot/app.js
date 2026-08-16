(() => {
  const history = {
    cpu: [],
    gpu: [],
    fps: [],
    down: [],
    up: []
  };
  const maxPoints = 72;
  let lastPacketAt = 0;

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

  function pushHistory(key, value) {
    const list = history[key];
    list.push(finite(value) ? value : null);
    if (list.length > maxPoints) list.shift();
  }

  function drawChart(canvas, series, colors, options = {}) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    const pad = 2 * ratio;
    const allValues = series.flat().filter(finite);
    const maximum = options.maximum ?? Math.max(options.minimumMaximum ?? 1, ...allValues);
    const minimum = options.minimum ?? 0;
    const range = Math.max(0.0001, maximum - minimum);

    series.forEach((values, seriesIndex) => {
      const valid = values.map((value, index) => ({ value, index })).filter(point => finite(point.value));
      if (valid.length < 2) return;
      const getX = (index) => pad + index / Math.max(1, maxPoints - 1) * (width - pad * 2);
      const getY = (value) => height - pad - (clamp(value, minimum, maximum) - minimum) / range * (height - pad * 2);

      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, `${colors[seriesIndex]}50`);
      gradient.addColorStop(1, `${colors[seriesIndex]}00`);

      context.beginPath();
      valid.forEach((point, index) => {
        const x = getX(point.index + (maxPoints - values.length));
        const y = getY(point.value);
        if (index === 0) context.moveTo(x, y);
        else {
          const previous = valid[index - 1];
          const previousX = getX(previous.index + (maxPoints - values.length));
          context.quadraticCurveTo((previousX + x) / 2, getY(previous.value), x, y);
        }
      });
      const lastX = getX(valid.at(-1).index + (maxPoints - values.length));
      const firstX = getX(valid[0].index + (maxPoints - values.length));
      context.lineTo(lastX, height);
      context.lineTo(firstX, height);
      context.closePath();
      context.fillStyle = gradient;
      context.fill();

      context.beginPath();
      valid.forEach((point, index) => {
        const x = getX(point.index + (maxPoints - values.length));
        const y = getY(point.value);
        if (index === 0) context.moveTo(x, y);
        else {
          const previous = valid[index - 1];
          const previousX = getX(previous.index + (maxPoints - values.length));
          context.quadraticCurveTo((previousX + x) / 2, getY(previous.value), x, y);
        }
      });
      context.strokeStyle = colors[seriesIndex];
      context.lineWidth = (seriesIndex === 0 ? 2.2 : 1.7) * ratio;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
    });
  }

  function renderCharts() {
    drawChart(byId("cpuChart"), [history.cpu], ["#6750a4"], { maximum: 100 });
    drawChart(byId("gpuChart"), [history.gpu], ["#8c4f00"], { maximum: 100 });
    drawChart(byId("fpsChart"), [history.fps], ["#b8f2c9"], { minimumMaximum: 120 });
    drawChart(byId("networkChart"), [history.down, history.up], ["#176b36", "#8c4f00"], { minimumMaximum: 1024 });
  }

  function update(data) {
    lastPacketAt = Date.now();
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

    pushHistory("cpu", data.cpuUsagePercent);
    pushHistory("gpu", data.gpuUsagePercent);
    pushHistory("fps", data.gameActive ? data.framerate : null);
    pushHistory("down", data.networkDownloadBytesPerSecond);
    pushHistory("up", data.networkUploadBytesPerSecond);
    renderCharts();

    if (data.afterburnerConnected && data.sourceFresh) setConnection("live", "实时");
    else if (data.afterburnerConnected) setConnection("waiting", "已暂停");
    else setConnection("error", "离线");
  }

  function updateClock() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const hourAngle = (hours % 12) * 30 + minutes * 0.5;
    const minuteAngle = minutes * 6 + seconds * 0.1;
    const secondAngle = seconds * 6;

    byId("clockHour").style.transform = `translateX(-50%) rotate(${hourAngle}deg)`;
    byId("clockMinute").style.transform = `translateX(-50%) rotate(${minuteAngle}deg)`;
    byId("clockSecond").style.transform = `translateX(-50%) rotate(${secondAngle}deg)`;
    byId("clockDial").style.setProperty("--seconds", String(seconds));
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

  window.addEventListener("resize", renderCharts, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      renderCharts();
      updateClock();
    }
  });
  updateClock();
  setInterval(updateClock, 1000);
  connect();
})();
