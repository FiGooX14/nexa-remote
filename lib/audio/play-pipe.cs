using System;
using System.Threading;
using NAudio.Wave;

class PlayPipe {
  static void Main() {
    var fmt = new WaveFormat(16000, 16, 1);
    var provider = new BufferedWaveProvider(fmt);
    provider.BufferDuration = TimeSpan.FromSeconds(2);
    provider.DiscardOnBufferOverflow = true;
    var waveOut = new WaveOutEvent();
    waveOut.Init(provider);
    waveOut.Play();
    var stdin = Console.OpenStandardInput();
    byte[] buf = new byte[65536];
    int n;
    try {
      while ((n = stdin.Read(buf, 0, buf.Length)) > 0) {
        provider.AddSamples(buf, 0, n);
      }
    } catch (Exception) { }
    int idle = 0;
    while (provider.BufferedBytes > 0 && idle < 400) {
      Thread.Sleep(50);
      idle++;
    }
    waveOut.Stop();
    waveOut.Dispose();
  }
}