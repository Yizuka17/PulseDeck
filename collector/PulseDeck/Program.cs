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
        builder.Services.AddSingleton<MetricsCollector>();
        builder.Services.AddHostedService(provider => provider.GetRequiredService<MetricsCollector>());

        var app = builder.Build();
        app.UseDefaultFiles();
        app.UseStaticFiles(new StaticFileOptions
        {
            OnPrepareResponse = context =>
                context.Context.Response.Headers.CacheControl = context.File.Name == "index.html"
                    ? "no-cache"
                    : "public,max-age=3600"
        });

        app.MapGet("/api/metrics", (MetricsCollector collector) => Results.Json(collector.Current, JsonOptions));
        app.MapGet("/api/info", () => Results.Json(new
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

    private static async Task StreamMetrics(HttpContext context, MetricsCollector collector)
    {
        context.Response.Headers.CacheControl = "no-cache";
        context.Response.Headers.Connection = "keep-alive";
        context.Response.ContentType = "text/event-stream; charset=utf-8";

        while (!context.RequestAborted.IsCancellationRequested)
        {
            var json = JsonSerializer.Serialize(collector.Current, JsonOptions);
            await context.Response.WriteAsync($"data: {json}\n\n", context.RequestAborted);
            await context.Response.Body.FlushAsync(context.RequestAborted);
            try { await Task.Delay(500, context.RequestAborted); }
            catch (OperationCanceledException) { break; }
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

internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly WebApplication _app;
    private readonly NotifyIcon _notifyIcon;
    private readonly Icon _trayIcon;
    private readonly string _dashboardUrl;

    public TrayApplicationContext(WebApplication app, int port)
    {
        _app = app;
        _dashboardUrl = Program.GetLanUrls(port).First();

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开仪表盘", null, (_, _) => OpenDashboard());
        menu.Items.Add("复制局域网地址", null, (_, _) => CopyLanUrl(port));
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
            : (Icon)SystemIcons.Application.Clone();

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
