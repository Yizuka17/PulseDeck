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

// This is the only telemetry shape exposed while Public Mode is enabled.
// Keep the allowlist explicit: adding a field to HardwareSnapshot must never
// accidentally publish a machine identifier, source state, or diagnostic text.
public sealed record PublicHardwareSnapshot(
    string CpuName,
    string GpuName,
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
    double NetworkUploadBytesPerSecond)
{
    public static PublicHardwareSnapshot From(HardwareSnapshot snapshot) => new(
        snapshot.CpuName,
        snapshot.GpuName,
        snapshot.CpuPowerWatts,
        snapshot.CpuTemperatureC,
        snapshot.CpuUsagePercent,
        snapshot.CpuClockMhz,
        snapshot.GpuPowerWatts,
        snapshot.GpuTemperatureC,
        snapshot.GpuUsagePercent,
        snapshot.GpuClockMhz,
        snapshot.GpuMemoryUsedMb,
        snapshot.GpuMemoryTotalMb,
        snapshot.RamUsedMb,
        snapshot.RamTotalMb,
        snapshot.Framerate,
        snapshot.FramerateOnePercentLow,
        snapshot.FrametimeMs,
        snapshot.NetworkDownloadBytesPerSecond,
        snapshot.NetworkUploadBytesPerSecond);
}

internal sealed record MahmEntry(string Name, string Unit, float? Value, uint GpuIndex, uint SourceId);
internal sealed record MahmGpu(string Name, double MemoryTotalMb);

internal sealed record MahmFrame(
    DateTimeOffset SourceTimestamp,
    IReadOnlyList<MahmEntry> Entries,
    IReadOnlyList<MahmGpu> Gpus);
