using Microsoft.Win32;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PulseDeck;

internal sealed class MetricsCollector : BackgroundService
{
    private const uint GlobalIndex = uint.MaxValue;
    private const uint GpuTemperature = 0x00000000;
    private const uint GpuClock = 0x00000020;
    private const uint GpuUsage = 0x00000030;
    private const uint GpuMemoryUsage = 0x00000031;
    private const uint Framerate = 0x00000050;
    private const uint Frametime = 0x00000051;
    private const uint FramerateOnePercentLow = 0x00000055;
    private const uint GpuAbsolutePower = 0x00000061;
    private const uint CpuTemperature = 0x00000080;
    private const uint CpuUsage = 0x00000090;
    private const uint RamUsage = 0x00000091;
    private const uint CpuClock = 0x000000A0;
    private const uint CpuPower = 0x00000100;

    private readonly object _sync = new();
    private readonly MahmReader _reader = new();
    private readonly NetworkMeter _network = new();
    private readonly string _cpuName = ReadCpuName();
    private readonly double _ramTotalMb = ReadMemory().TotalMb;
    private string? _cachedGpuName;
    private double? _cachedGpuMemoryTotalMb;
    private HardwareSnapshot _current;

    public MetricsCollector()
    {
        _current = HardwareSnapshot.Waiting(Environment.MachineName, _cpuName, _ramTotalMb);
    }

    public HardwareSnapshot Current
    {
        get { lock (_sync) return _current; }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var network = _network.Sample();
            HardwareSnapshot snapshot;

            if (_reader.TryRead(out var frame, out var error) && frame is not null)
            {
                snapshot = BuildSnapshot(frame, network);
            }
            else
            {
                var memory = ReadMemory();
                snapshot = HardwareSnapshot.Waiting(Environment.MachineName, _cpuName, memory.TotalMb) with
                {
                    Timestamp = DateTimeOffset.Now,
                    RamUsedMb = memory.UsedMb,
                    NetworkDownloadBytesPerSecond = network.DownloadBytesPerSecond,
                    NetworkUploadBytesPerSecond = network.UploadBytesPerSecond,
                    Error = error
                };
            }

            lock (_sync) _current = snapshot;

            try { await Task.Delay(500, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        }
    }

    private HardwareSnapshot BuildSnapshot(
        MahmFrame frame,
        (double DownloadBytesPerSecond, double UploadBytesPerSecond) network)
    {
        var selectedGpu = frame.Gpus
            .Select((gpu, index) => (gpu, index))
            .OrderByDescending(item => item.gpu.MemoryTotalMb)
            .FirstOrDefault();
        var gpuIndex = selectedGpu.gpu is null ? 0u : (uint)selectedGpu.index;
        var gpuName = selectedGpu.gpu?.Name ?? "未识别 GPU";
        var memory = ReadMemory();

        double? Value(uint sourceId, uint? index = null, string? exactName = null, string? exactUnit = null)
        {
            IEnumerable<MahmEntry> matches = frame.Entries.Where(entry => entry.SourceId == sourceId && entry.Value.HasValue);
            if (exactName is not null)
                matches = matches.Where(entry => entry.Name.Equals(exactName, StringComparison.OrdinalIgnoreCase));
            if (exactUnit is not null)
                matches = matches.Where(entry => entry.Unit.Equals(exactUnit, StringComparison.OrdinalIgnoreCase));
            if (index.HasValue)
                matches = matches.Where(entry => entry.GpuIndex == index.Value);
            else
                matches = matches.OrderByDescending(entry => entry.GpuIndex == GlobalIndex);
            return matches.Select(entry => (double?)entry.Value).FirstOrDefault();
        }

        // These are the raw MAHM sensors exposed by MSI Afterburner. Frametime is
        // intentionally not calculated from FPS: Afterburner updates them on separate windows.
        var fps = Value(Framerate, exactName: "Framerate", exactUnit: "FPS");
        var frameTime = Value(Frametime, exactName: "Frametime", exactUnit: "ms");
        var onePercentLow = Value(FramerateOnePercentLow, exactName: "Framerate 1% Low", exactUnit: "FPS");
        var sourceFresh = Math.Abs((DateTimeOffset.Now - frame.SourceTimestamp).TotalSeconds) < 5;
        var gameActive = fps is > 0.01 && frameTime is > 0.01;

        var gpuMemoryUsed = Value(GpuMemoryUsage, gpuIndex);
        var gpuMemoryTotal = selectedGpu.gpu?.MemoryTotalMb;
        if (gpuMemoryTotal is null or <= 0 || (gpuMemoryUsed.HasValue && gpuMemoryTotal < gpuMemoryUsed))
        {
            if (!string.Equals(_cachedGpuName, gpuName, StringComparison.OrdinalIgnoreCase))
            {
                _cachedGpuName = gpuName;
                _cachedGpuMemoryTotalMb = QueryNvidiaMemoryTotalMb(gpuName);
            }
            gpuMemoryTotal = _cachedGpuMemoryTotalMb;
        }

        return new HardwareSnapshot(
            DateTimeOffset.Now,
            Environment.MachineName,
            _cpuName,
            gpuName,
            true,
            sourceFresh,
            gameActive,
            Value(CpuPower),
            Value(CpuTemperature),
            Value(CpuUsage),
            Value(CpuClock),
            Value(GpuAbsolutePower, gpuIndex),
            Value(GpuTemperature, gpuIndex),
            Value(GpuUsage, gpuIndex),
            Value(GpuClock, gpuIndex),
            gpuMemoryUsed,
            gpuMemoryTotal,
            Value(RamUsage, exactName: "RAM usage") ?? memory.UsedMb,
            memory.TotalMb,
            fps,
            onePercentLow,
            frameTime,
            network.DownloadBytesPerSecond,
            network.UploadBytesPerSecond,
            null);
    }

    public override void Dispose()
    {
        _reader.Dispose();
        base.Dispose();
    }

    private static string ReadCpuName()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
            return (key?.GetValue("ProcessorNameString") as string)?.Trim() ?? "Windows CPU";
        }
        catch { return "Windows CPU"; }
    }

    private static double? QueryNvidiaMemoryTotalMb(string gpuName)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "nvidia-smi.exe",
                Arguments = "--query-gpu=name,memory.total --format=csv,noheader,nounits",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            });
            if (process is null) return null;
            var output = process.StandardOutput.ReadToEnd();
            if (!process.WaitForExit(1500))
            {
                process.Kill(true);
                return null;
            }

            var rows = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(row => row.Split(',', 2, StringSplitOptions.TrimEntries))
                .Where(parts => parts.Length == 2 && double.TryParse(parts[1], System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out _))
                .ToArray();
            var match = rows.FirstOrDefault(parts =>
                gpuName.Contains(parts[0], StringComparison.OrdinalIgnoreCase) ||
                parts[0].Contains(gpuName, StringComparison.OrdinalIgnoreCase)) ?? rows.FirstOrDefault();
            return match is not null && double.TryParse(match[1], System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var memoryMb)
                ? memoryMb
                : null;
        }
        catch { return null; }
    }

    private static (double TotalMb, double UsedMb) ReadMemory()
    {
        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        if (!GlobalMemoryStatusEx(ref status)) return (0, 0);
        const double bytesPerMb = 1024d * 1024d;
        return (status.TotalPhysical / bytesPerMb, (status.TotalPhysical - status.AvailablePhysical) / bytesPerMb);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhysical;
        public ulong AvailablePhysical;
        public ulong TotalPageFile;
        public ulong AvailablePageFile;
        public ulong TotalVirtual;
        public ulong AvailableVirtual;
        public ulong AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx status);
}
