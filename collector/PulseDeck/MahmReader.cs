using System.IO.MemoryMappedFiles;
using System.Text;

namespace PulseDeck;

internal sealed class MahmReader : IDisposable
{
    private const uint SignatureMahm = 0x4D41484D;
    private const uint SignatureDead = 0x0000DEAD;
    private const int NameFieldLength = 260;
    private const int MinimumEntrySize = 1324;
    private const int MinimumGpuEntrySize = 1304;

    private MemoryMappedFile? _mapping;
    private MemoryMappedViewAccessor? _view;

    public bool TryRead(out MahmFrame? frame, out string? error)
    {
        frame = null;
        error = null;

        try
        {
            EnsureConnected();
            if (_view is null)
            {
                error = "MSI Afterburner 尚未创建共享内存";
                return false;
            }

            var signature = _view.ReadUInt32(0);
            if (signature == SignatureDead)
            {
                Disconnect();
                error = "Afterburner 正在重启";
                return false;
            }

            if (signature != SignatureMahm)
            {
                error = $"共享内存签名无效：0x{signature:X8}";
                return false;
            }

            var version = _view.ReadUInt32(4);
            var headerSize = _view.ReadUInt32(8);
            var entryCount = _view.ReadUInt32(12);
            var entrySize = _view.ReadUInt32(16);
            var sourceTime = _view.ReadInt32(20);
            var gpuCount = version >= 0x00020000 ? _view.ReadUInt32(24) : 0;
            var gpuEntrySize = version >= 0x00020000 ? _view.ReadUInt32(28) : 0;

            if (headerSize < 24 || headerSize > 4096 || entryCount > 4096 || entrySize < MinimumEntrySize)
                throw new InvalidDataException("Afterburner 共享内存布局不受支持");
            if (gpuCount > 128 || (gpuCount > 0 && gpuEntrySize < MinimumGpuEntrySize))
                throw new InvalidDataException("Afterburner GPU 共享内存布局不受支持");

            var entries = new List<MahmEntry>((int)entryCount);
            for (var index = 0u; index < entryCount; index++)
            {
                var offset = (long)headerSize + (long)index * entrySize;
                var name = ReadAnsi(offset, NameFieldLength);
                var unit = NormalizeUnit(ReadAnsi(offset + NameFieldLength, NameFieldLength));
                var rawValue = _view.ReadSingle(offset + 1300);
                var gpuIndex = _view.ReadUInt32(offset + 1316);
                var sourceId = _view.ReadUInt32(offset + 1320);
                float? value = float.IsFinite(rawValue) && rawValue < float.MaxValue / 2 ? rawValue : null;
                entries.Add(new MahmEntry(name, unit, value, gpuIndex, sourceId));
            }

            var gpus = new List<MahmGpu>((int)gpuCount);
            var gpuBase = (long)headerSize + (long)entryCount * entrySize;
            for (var index = 0u; index < gpuCount; index++)
            {
                var offset = gpuBase + (long)index * gpuEntrySize;
                var name = ReadAnsi(offset + 520, NameFieldLength);
                var memoryKb = _view.ReadUInt32(offset + 1300);
                gpus.Add(new MahmGpu(string.IsNullOrWhiteSpace(name) ? $"GPU {index + 1}" : name, memoryKb / 1024d));
            }

            DateTimeOffset timestamp;
            try { timestamp = DateTimeOffset.FromUnixTimeSeconds(sourceTime).ToLocalTime(); }
            catch { timestamp = DateTimeOffset.Now; }

            frame = new MahmFrame(timestamp, entries, gpus);
            return true;
        }
        catch (FileNotFoundException)
        {
            Disconnect();
            error = "MSI Afterburner 尚未运行";
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            Disconnect();
            error = "无法读取 Afterburner 共享内存，请确认两个程序在同一用户会话中运行";
            return false;
        }
        catch (Exception exception)
        {
            Disconnect();
            error = exception.Message;
            return false;
        }
    }

    private void EnsureConnected()
    {
        if (_view is not null) return;
        _mapping = MemoryMappedFile.OpenExisting("MAHMSharedMemory", MemoryMappedFileRights.Read);
        _view = _mapping.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
    }

    private string ReadAnsi(long offset, int length)
    {
        var bytes = new byte[length];
        _view!.ReadArray(offset, bytes, 0, bytes.Length);
        var terminator = Array.IndexOf(bytes, (byte)0);
        if (terminator < 0) terminator = bytes.Length;
        return Encoding.ASCII.GetString(bytes, 0, terminator).Trim();
    }

    private static string NormalizeUnit(string unit) => unit switch
    {
        "?C" => "°C",
        _ => unit
    };

    private void Disconnect()
    {
        _view?.Dispose();
        _mapping?.Dispose();
        _view = null;
        _mapping = null;
    }

    public void Dispose() => Disconnect();
}
