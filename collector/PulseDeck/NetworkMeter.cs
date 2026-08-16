using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace PulseDeck;

internal sealed class NetworkMeter
{
    private long _lastReceived;
    private long _lastSent;
    private DateTimeOffset _lastSample;

    public (double DownloadBytesPerSecond, double UploadBytesPerSecond) Sample()
    {
        long received = 0;
        long sent = 0;

        foreach (var network in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (network.OperationalStatus != OperationalStatus.Up ||
                network.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
                continue;

            var hasIpv4 = network.GetIPProperties().UnicastAddresses.Any(address =>
                address.Address.AddressFamily == AddressFamily.InterNetwork &&
                !System.Net.IPAddress.IsLoopback(address.Address));
            if (!hasIpv4) continue;

            try
            {
                var stats = network.GetIPv4Statistics();
                received += stats.BytesReceived;
                sent += stats.BytesSent;
            }
            catch (NetworkInformationException)
            {
                // Some virtual adapters disappear between enumeration and sampling.
            }
        }

        var now = DateTimeOffset.UtcNow;
        if (_lastSample == default)
        {
            _lastReceived = received;
            _lastSent = sent;
            _lastSample = now;
            return (0, 0);
        }

        var elapsed = Math.Max(0.001, (now - _lastSample).TotalSeconds);
        var down = Math.Max(0, received - _lastReceived) / elapsed;
        var up = Math.Max(0, sent - _lastSent) / elapsed;

        _lastReceived = received;
        _lastSent = sent;
        _lastSample = now;
        return (down, up);
    }
}
