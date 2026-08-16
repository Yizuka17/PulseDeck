namespace PulseDeck;

public sealed record HardwareSnapshot(
    DateTimeOffset Timestamp,
    string MachineName,
    string CpuName,
    string GpuName,
    bool AfterburnerConnected,
    bool SourceFresh,
    bool GameActive,
    double? CpuPowerWatts,
    double? CpuTemperatureC,
    double? CpuUsagePercent,
    double? CpuClockMhz,
    double? GpuPowerWatts,
    double? GpuTemperatureC,
    double? GpuUsagePercent,
    double? GpuClockMhz,
    double? GpuMemoryUsedMb,
    double? GpuMemoryTotalMb,
    double? RamUsedMb,
    double RamTotalMb,
    double? Framerate,
    double? FramerateOnePercentLow,
    double? FrametimeMs,
    double NetworkDownloadBytesPerSecond,
    double NetworkUploadBytesPerSecond,
    string? Error)
{
    public static HardwareSnapshot Waiting(string machineName, string cpuName, double ramTotalMb) => new(
        DateTimeOffset.Now, machineName, cpuName, "等待 Afterburner…", false, false, false,
        null, null, null, null, null, null, null, null, null, null,
        null, ramTotalMb, null, null, null, 0, 0, "正在连接 MAHMSharedMemory");
}

internal sealed record MahmEntry(string Name, string Unit, float? Value, uint GpuIndex, uint SourceId);
internal sealed record MahmGpu(string Name, double MemoryTotalMb);

internal sealed record MahmFrame(
    DateTimeOffset SourceTimestamp,
    IReadOnlyList<MahmEntry> Entries,
    IReadOnlyList<MahmGpu> Gpus);
