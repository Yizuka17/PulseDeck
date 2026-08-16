# Pulse Deck

Pulse Deck 是一个常驻 Windows 系统托盘的局域网硬件监控面板。它从 MSI Afterburner 的 MAHM 共享内存读取实时指标，并通过网页提供给同一局域网内的手机、平板和其他电脑查看。

![Pulse Deck icon](collector/PulseDeck/wwwroot/favicon.svg)

## 预览

![Pulse Deck 面板预览](docs/dashboard-preview.png)

## 功能

- CPU：名称、频率、占用率、功耗、温度
- GPU：名称、核心频率、占用率、功耗、温度、显存占用
- 内存占用与网络上传/下载速度
- RTSS 当前帧率、1% Low 与帧时间
- Material Design 3 Expressive 响应式界面
- 系统托盘、局域网地址复制、随 Windows 启动
- SSE 实时推送，默认每 500 ms 更新

## 使用

1. 安装并保持 MSI Afterburner 在后台运行。
2. 如需游戏帧率数据，同时运行 RivaTuner Statistics Server（RTSS）。
3. 安装并启动 Pulse Deck。首次启动若出现 Windows 防火墙提示，请只允许“专用网络”。
4. 双击托盘图标打开本机面板，或右键托盘图标选择“复制局域网地址”，发送到其他设备访问。

默认地址为 `http://localhost:5174`，也可使用 `PulseDeck.exe --port 端口号` 指定端口。

> 不同硬件和驱动能否提供某项传感器，取决于 MSI Afterburner 暴露的监控源。CPU 功耗读取使用 Afterburner 的 CPU power 数据源。

## 隐私

Pulse Deck 不包含云服务、账号系统或遥测。硬件数据只由本机 HTTP 服务提供。请仅在可信的局域网中运行，不要把端口直接暴露到公网。

## 从源码构建

需要 .NET 8 SDK 和 Windows 10/11：

```powershell
dotnet build collector\PulseDeck\PulseDeck.csproj -c Release
dotnet run --project collector\PulseDeck\PulseDeck.csproj -- --port 5174
```

生成自包含的发布包和安装程序：

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
```

构建结果位于 `artifacts\release`。

## 技术说明

- 运行平台：Windows x64
- 后端：ASP.NET Core 8 + Windows Forms 托盘
- 数据源：MSI Afterburner MAHM SharedMemory、RTSS、Windows 网络接口统计
- 前端：原生 HTML、CSS、Canvas 与 JavaScript
