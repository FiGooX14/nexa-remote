using System;
using System.IO;
using System.Threading;
using NAudio.Wave;

class Program {
  static void Main() {
    var sout = Console.OpenStandardOutput();
    using (var cap = new WasapiLoopbackCapture()) {
      int ch = Math.Max(1, cap.WaveFormat.Channels);
      int sr = cap.WaveFormat.SampleRate;

      byte[] wavHead = new byte[44];
      using (var ms = new MemoryStream(wavHead)) {
        var bw = new BinaryWriter(ms);
        bw.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
        bw.Write((uint)0x7FFFFFFF);
        bw.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
        bw.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
        bw.Write((int)16);
        bw.Write((short)1);
        bw.Write((short)ch);
        bw.Write((int)sr);
        bw.Write((int)(sr * ch * 2));
        bw.Write((short)(ch * 2));
        bw.Write((short)16);
        bw.Write(System.Text.Encoding.ASCII.GetBytes("data"));
        bw.Write((uint)0x7FFFFFFF);
        bw.Flush();
      }
      sout.Write(wavHead, 0, wavHead.Length);
      sout.Flush();

      bool isFloat = cap.WaveFormat.Encoding == WaveFormatEncoding.IeeeFloat ||
                     cap.WaveFormat.Encoding == WaveFormatEncoding.Extensible;
      cap.DataAvailable += (s, e) => {
        if (isFloat) {
          int n = e.BytesRecorded;
          int frames = n / 4;
          byte[] outb = new byte[frames * 2];
          for (int i = 0; i < frames; i++) {
            float f = BitConverter.ToSingle(e.Buffer, i * 4);
            if (f > 1f) f = 1f;
            if (f < -1f) f = -1f;
            short v = (short)(f * 32767f);
            outb[i * 2] = (byte)(v & 0xFF);
            outb[i * 2 + 1] = (byte)((v >> 8) & 0xFF);
          }
          sout.Write(outb, 0, outb.Length);
        } else {
          sout.Write(e.Buffer, 0, e.BytesRecorded);
        }
        sout.Flush();
      };
      cap.StartRecording();
      while (true) Thread.Sleep(10000);
    }
  }
}