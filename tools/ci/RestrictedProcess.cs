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
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint count,ref Sid disabled,uint delete,IntPtr privileges,uint restrict,IntPtr sids,out IntPtr result);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,ref Sid info,int length);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref SecurityAttributes security,uint disposition,uint flags,IntPtr template);
    static IntPtr AllocateSid(string value) {
        var sid=new SecurityIdentifier(value); var bytes=new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes,0);
        var pointer=Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes,0,pointer,bytes.Length); return pointer;
    }
    public static int Run(string executable,string command,string cwd,string outputFile) {
        IntPtr original=IntPtr.Zero, restricted=IntPtr.Zero;
        IntPtr input=IntPtr.Zero, output=IntPtr.Zero;
        var admin=AllocateSid("S-1-5-32-544");
        try {
            if(!OpenProcessToken(GetCurrentProcess(),0xF01FF,out original)) throw new Win32Exception();
            var disabled=new Sid{Pointer=admin};
            // Disable the Administrators SID and all privileges except traversal.
            // Retain the runner desktop's integrity level: UAC-disabled hosted desktops
            // reject medium-integrity GUI startup with STATUS_DLL_INIT_FAILED.
            if(!CreateRestrictedToken(original,1,1,ref disabled,0,IntPtr.Zero,0,IntPtr.Zero,out restricted)) throw new Win32Exception();
            var security=new SecurityAttributes{Size=Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=true};
            input=CreateFileW("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);
            output=CreateFileW(outputFile,0x40000000,3,ref security,2,0,IntPtr.Zero);
            if(input==new IntPtr(-1)||output==new IntPtr(-1))throw new Win32Exception();
            var startup=new Startup{Size=Marshal.SizeOf(typeof(Startup)),Flags=0x101,Show=0,Input=input,Output=output,Error=output}; ProcessInfo child;
            // Explicit inheritable file/NUL handles also work on runners without a
            // desktop console. Capture early startup errors before script redirection.
            if(!CreateProcessAsUserW(restricted,executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000000,IntPtr.Zero,cwd,ref startup,out child)) throw new Win32Exception();
            try {
                if(WaitForSingleObject(child.Process,0xffffffff)!=0) throw new Win32Exception();
                uint code; if(!GetExitCodeProcess(child.Process,out code)) throw new Win32Exception(); return (int)code;
            } finally {CloseHandle(child.Thread);CloseHandle(child.Process);}
        } finally {if(input!=IntPtr.Zero&&input!=new IntPtr(-1))CloseHandle(input);if(output!=IntPtr.Zero&&output!=new IntPtr(-1))CloseHandle(output);if(original!=IntPtr.Zero)CloseHandle(original);if(restricted!=IntPtr.Zero)CloseHandle(restricted);Marshal.FreeHGlobal(admin);}
    }
}
