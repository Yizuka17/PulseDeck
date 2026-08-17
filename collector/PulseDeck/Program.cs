using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Win32;

namespace PulseDeck;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var port = ParsePort(args);

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = args,
            ContentRootPath = AppContext.BaseDirectory,
            WebRootPath = "wwwroot"
        });
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
        builder.Services.AddSingleton(new PublicModeSettings(ParsePublicMode(args)));
        builder.Services.AddSingleton<MetricsCollector>();
        builder.Services.AddHostedService(provider => provider.GetRequiredService<MetricsCollector>());
        builder.Services.AddSingleton<SseConnectionLimiter>();

        var app = builder.Build();
        app.UseDefaultFiles();
        app.UseStaticFiles(new StaticFileOptions
        {
            OnPrepareResponse = context =>
                context.Context.Response.Headers.CacheControl = context.File.Name == "index.html"
                    ? "no-cache"
                    : "public,max-age=3600"
        });

        app.MapGet("/api/metrics", (MetricsCollector collector, PublicModeSettings publicMode) =>
            Results.Json(CreateMetricsPayload(collector.Current, publicMode.Enabled), JsonOptions));
        app.MapGet("/api/info", (PublicModeSettings publicMode) => publicMode.Enabled
            ? Results.NotFound()
            : Results.Json(new
            {
                app = "Pulse Deck",
                version = typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "1.0.0",
                urls = GetLanUrls(port)
            }, JsonOptions));
        app.MapGet("/api/stream", StreamMetrics);
        app.MapFallbackToFile("index.html");

        try
        {
            app.StartAsync().GetAwaiter().GetResult();
            Application.Run(new TrayApplicationContext(app, port));
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                $"Pulse Deck 无法启动。\n\n{exception.Message}",
                "Pulse Deck",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static object CreateMetricsPayload(HardwareSnapshot snapshot, bool publicMode) =>
        publicMode ? PublicHardwareSnapshot.From(snapshot) : snapshot;

    private static async Task StreamMetrics(
        HttpContext context,
        MetricsCollector collector,
        PublicModeSettings publicMode,
        SseConnectionLimiter connectionLimiter)
    {
        if (!connectionLimiter.TryAcquire(context, out var lease))
        {
            context.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            context.Response.Headers.RetryAfter = "15";
            await context.Response.WriteAsync("Too many realtime connections.", context.RequestAborted);
            return;
        }

        using (lease)
        {
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";
            context.Response.ContentType = "text/event-stream; charset=utf-8";

            while (!context.RequestAborted.IsCancellationRequested)
            {
                var snapshot = collector.Current;
                var json = JsonSerializer.Serialize(CreateMetricsPayload(snapshot, publicMode.Enabled), JsonOptions);
                await context.Response.WriteAsync($"data: {json}\n\n", context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
                var nextUpdateDelay = snapshot.GameActive ? 500 : 1000;
                try { await Task.Delay(nextUpdateDelay, context.RequestAborted); }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    private static int ParsePort(string[] args)
    {
        for (var index = 0; index < args.Length - 1; index++)
            if (args[index].Equals("--port", StringComparison.OrdinalIgnoreCase) &&
                int.TryParse(args[index + 1], out var port) && port is > 0 and < 65536)
                return port;
        return 5174;
    }

    private static bool? ParsePublicMode(string[] args)
    {
        if (args.Any(argument => argument.Equals("--public", StringComparison.OrdinalIgnoreCase))) return true;
        if (args.Any(argument => argument.Equals("--private", StringComparison.OrdinalIgnoreCase))) return false;
        return null;
    }

    internal static string[] GetLanUrls(int port)
    {
        var urls = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { $"http://localhost:{port}" };
        foreach (var network in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (network.OperationalStatus != OperationalStatus.Up) continue;
            foreach (var address in network.GetIPProperties().UnicastAddresses)
            {
                var ip = address.Address;
                if (ip.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(ip)) continue;
                var bytes = ip.GetAddressBytes();
                var isPrivate = bytes[0] == 10 ||
                                (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) ||
                                (bytes[0] == 192 && bytes[1] == 168);
                if (isPrivate) urls.Add($"http://{ip}:{port}");
            }
        }
        return urls.ToArray();
    }
}

internal sealed class PublicModeSettings
{
    private const string SettingsKeyPath = @"Software\PulseDeck";
    private const string PublicModeValueName = "PublicMode";
    private readonly object _sync = new();
    private bool _enabled;

    public PublicModeSettings(bool? commandLineValue)
    {
        _enabled = commandLineValue ?? ReadPersistedValue();
        if (commandLineValue.HasValue) PersistValue(commandLineValue.Value);
    }

    public bool Enabled
    {
        get { lock (_sync) return _enabled; }
    }

    public void SetEnabled(bool enabled)
    {
        lock (_sync) _enabled = enabled;
        PersistValue(enabled);
    }

    private static bool ReadPersistedValue()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath);
            return Convert.ToInt32(key?.GetValue(PublicModeValueName, 0)) != 0;
        }
        catch { return false; }
    }

    private static void PersistValue(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath);
            key.SetValue(PublicModeValueName, enabled ? 1 : 0, RegistryValueKind.DWord);
        }
        catch { /* The mode still applies for this process if registry writes are unavailable. */ }
    }
}

internal sealed class SseConnectionLimiter
{
    private const int MaxConnections = 12;
    private const int MaxConnectionsPerClient = 3;
    private readonly object _sync = new();
    private readonly Dictionary<string, int> _connectionsByClient = new(StringComparer.Ordinal);
    private int _activeConnections;

    public bool TryAcquire(HttpContext context, out IDisposable? lease)
    {
        var clientKey = GetClientKey(context);
        lock (_sync)
        {
            if (_activeConnections >= MaxConnections ||
                clientKey is not null && _connectionsByClient.GetValueOrDefault(clientKey) >= MaxConnectionsPerClient)
            {
                lease = null;
                return false;
            }

            _activeConnections++;
            if (clientKey is not null)
                _connectionsByClient[clientKey] = _connectionsByClient.GetValueOrDefault(clientKey) + 1;
            lease = new Lease(this, clientKey);
            return true;
        }
    }

    private static string? GetClientKey(HttpContext context)
    {
        // Cloudflare Tunnel forwards this header for public clients. Do not make
        // localhost share a tiny per-client budget when that header is absent.
        var forwarded = context.Request.Headers["CF-Connecting-IP"].ToString().Trim();
        if (IPAddress.TryParse(forwarded, out var forwardedAddress))
            return forwardedAddress.MapToIPv4().ToString();

        var remoteAddress = context.Connection.RemoteIpAddress;
        return remoteAddress is null || IPAddress.IsLoopback(remoteAddress)
            ? null
            : remoteAddress.MapToIPv4().ToString();
    }

    private void Release(string? clientKey)
    {
        lock (_sync)
        {
            _activeConnections = Math.Max(0, _activeConnections - 1);
            if (clientKey is null) return;
            var remaining = _connectionsByClient.GetValueOrDefault(clientKey) - 1;
            if (remaining <= 0) _connectionsByClient.Remove(clientKey);
            else _connectionsByClient[clientKey] = remaining;
        }
    }

    private sealed class Lease : IDisposable
    {
        private SseConnectionLimiter? _owner;
        private readonly string? _clientKey;

        public Lease(SseConnectionLimiter owner, string? clientKey)
        {
            _owner = owner;
            _clientKey = clientKey;
        }

        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Release(_clientKey);
    }
}

internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly WebApplication _app;
    private readonly NotifyIcon _notifyIcon;
    private readonly Icon _trayIcon;
    private readonly string _dashboardUrl;
    private readonly PublicModeSettings _publicMode;

    public TrayApplicationContext(WebApplication app, int port)
    {
        _app = app;
        _publicMode = app.Services.GetRequiredService<PublicModeSettings>();
        _dashboardUrl = Program.GetLanUrls(port).First();

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开仪表盘", null, (_, _) => OpenDashboard());
        menu.Items.Add("复制局域网地址", null, (_, _) => CopyLanUrl(port));
        var publicMode = new ToolStripMenuItem("公网模式（隐藏设备信息）") { Checked = _publicMode.Enabled };
        publicMode.Click += (_, _) =>
        {
            var next = !publicMode.Checked;
            _publicMode.SetEnabled(next);
            publicMode.Checked = next;
            if (_notifyIcon is not null)
                _notifyIcon.ShowBalloonTip(2200, "Pulse Deck", next
                    ? "公网模式已开启：接口仅提供白名单硬件指标。"
                    : "公网模式已关闭：恢复局域网完整接口。", ToolTipIcon.Info);
        };
        menu.Items.Add(publicMode);
        var autoStart = new ToolStripMenuItem("随 Windows 启动") { Checked = AutoStartManager.IsEnabled() };
        autoStart.Click += (_, _) =>
        {
            var next = !autoStart.Checked;
            AutoStartManager.SetEnabled(next);
            autoStart.Checked = next;
        };
        menu.Items.Add(autoStart);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出 Pulse Deck", null, (_, _) => Exit());

        var trayIconPath = Path.Combine(AppContext.BaseDirectory, "tray-icon.ico");
        _trayIcon = File.Exists(trayIconPath)
            ? new Icon(trayIconPath)
            // Single-file launches can be missing sidecar files. The EXE embeds the
            // same custom icon, so keep the tray branded instead of falling back to
            // the generic Windows application icon.
            : Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? (Icon)SystemIcons.Application.Clone();

        _notifyIcon = new NotifyIcon
        {
            Icon = _trayIcon,
            Text = "Pulse Deck · 硬件状态",
            ContextMenuStrip = menu,
            Visible = true
        };
        _notifyIcon.DoubleClick += (_, _) => OpenDashboard();
        _notifyIcon.ShowBalloonTip(2600, "Pulse Deck 已启动", $"双击托盘图标打开 {_dashboardUrl}", ToolTipIcon.Info);
    }

    private void OpenDashboard() => Process.Start(new ProcessStartInfo(_dashboardUrl) { UseShellExecute = true });

    private static void CopyLanUrl(int port)
    {
        var url = Program.GetLanUrls(port).FirstOrDefault(item => !item.Contains("localhost"))
                  ?? Program.GetLanUrls(port).First();
        Clipboard.SetText(url);
    }

    private void Exit()
    {
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _trayIcon.Dispose();
        _app.StopAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult();
        _app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        ExitThread();
    }
}

internal static class AutoStartManager
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "PulseDeck";

    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
            var expected = Quote(Environment.ProcessPath ?? Application.ExecutablePath);
            return string.Equals(key?.GetValue(ValueName) as string, expected, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
        if (enabled)
            key.SetValue(ValueName, Quote(Environment.ProcessPath ?? Application.ExecutablePath), RegistryValueKind.String);
        else
            key.DeleteValue(ValueName, false);
    }

    private static string Quote(string path) => $"\"{path}\"";
}
