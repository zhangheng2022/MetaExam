using System;
using System.Runtime.InteropServices;

// Windows Authenticode policy, offline and without changing any certificate store.
public static class MetaExamAuthenticode {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileInfo {
        public uint Size;
        [MarshalAs(UnmanagedType.LPWStr)] public string Path;
        public IntPtr Handle, Subject;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct TrustData {
        public uint Size;
        public IntPtr Policy, Sip;
        public uint Ui, Revocation, Choice;
        public IntPtr File;
        public uint Action;
        public IntPtr State, Url;
        public uint Flags, Context;
        public IntPtr Settings;
    }
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern uint WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    public static uint Check(string path) {
        var file = new FileInfo { Size = (uint)Marshal.SizeOf(typeof(FileInfo)), Path = path };
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
        Marshal.StructureToPtr(file, pointer, false);
        var data = new TrustData {
            Size = (uint)Marshal.SizeOf(typeof(TrustData)), Ui = 2, Choice = 1,
            File = pointer, Action = 1, Flags = 0x1000 | 0x10
        };
        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try { return WinVerifyTrust(new IntPtr(-1), ref action, ref data); }
        finally {
            data.Action = 2;
            WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            Marshal.DestroyStructure(pointer, typeof(FileInfo));
            Marshal.FreeHGlobal(pointer);
        }
    }
}
