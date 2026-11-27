using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class MetaExamRestrictedProcess {
    [StructLayout(LayoutKind.Sequential)] struct Sid { public IntPtr Pointer; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int Size; public string Reserved, Desktop, Title;
        public int X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
        public short Show,ReservedSize; public IntPtr Reserved2,Input,Output,Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Id,ThreadId; }
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint count,ref Sid disabled,uint delete,IntPtr privileges,uint restrict,IntPtr sids,out IntPtr result);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,ref Sid info,int length);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static IntPtr AllocateSid(string value) {
        var sid=new SecurityIdentifier(value); var bytes=new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes,0);
        var pointer=Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes,0,pointer,bytes.Length); return pointer;
    }
    public static int Run(string executable,string command,string cwd) {
        IntPtr original=IntPtr.Zero, restricted=IntPtr.Zero;
        var admin=AllocateSid("S-1-5-32-544"); var medium=AllocateSid("S-1-16-8192");
        try {
            if(!OpenProcessToken(GetCurrentProcess(),0xF01FF,out original)) throw new Win32Exception();
            var disabled=new Sid{Pointer=admin};
            if(!CreateRestrictedToken(original,5,1,ref disabled,0,IntPtr.Zero,0,IntPtr.Zero,out restricted)) throw new Win32Exception();
            var integrity=new Sid{Pointer=medium,Attributes=0x20};
            if(!SetTokenInformation(restricted,25,ref integrity,Marshal.SizeOf(typeof(Sid))+new SecurityIdentifier("S-1-16-8192").BinaryLength)) throw new Win32Exception();
            var startup=new Startup{Size=Marshal.SizeOf(typeof(Startup)),Flags=1,Show=0}; ProcessInfo child;
            if(!CreateProcessAsUserW(restricted,executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,cwd,ref startup,out child)) throw new Win32Exception();
            try {
                if(WaitForSingleObject(child.Process,0xffffffff)!=0) throw new Win32Exception();
                uint code; if(!GetExitCodeProcess(child.Process,out code)) throw new Win32Exception(); return (int)code;
            } finally {CloseHandle(child.Thread);CloseHandle(child.Process);}
        } finally {if(original!=IntPtr.Zero)CloseHandle(original);if(restricted!=IntPtr.Zero)CloseHandle(restricted);Marshal.FreeHGlobal(admin);Marshal.FreeHGlobal(medium);}
    }
}
