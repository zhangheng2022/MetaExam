using System;
using System.IO;
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
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr acl,out bool defaulted);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,ref IntPtr info,int length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowStationW(string name,uint flags,uint access,ref SecurityAttributes security);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktopW(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SecurityAttributes security);
    [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string app,StringBuilder command,ref SecurityAttributes processAttributes,ref SecurityAttributes threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
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
        IntPtr station=IntPtr.Zero,desktop=IntPtr.Zero,descriptor=IntPtr.Zero;
        var admin=AllocateSid("S-1-5-32-544");
        try {
            if(!OpenProcessToken(GetCurrentProcess(),0xF01FF,out original)) throw new Win32Exception();
            var disabled=new Sid{Pointer=admin};
            // Disable the Administrators SID and all privileges except traversal.
            if(!CreateRestrictedToken(original,1,1,ref disabled,0,IntPtr.Zero,0,IntPtr.Zero,out restricted)) throw new Win32Exception();
            // The hosted runner desktop may grant access only to Administrators.
            // Use a private, noninteractive station/desktop with explicit same-user ACLs;
            // do not weaken the existing desktop or grant access to Everyone.
            uint descriptorSize;
            if(!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:(A;;GA;;;SY)(A;;GA;;;"+WindowsIdentity.GetCurrent().User.Value+")",1,out descriptor,out descriptorSize))throw new Win32Exception();
            var desktopSecurity=new SecurityAttributes{Size=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor};
            // A runner token can also have an Administrators-only default DACL.
            // Child processes/threads must remain accessible to their actual user.
            bool present,defaulted; IntPtr defaultAcl;
            if(!GetSecurityDescriptorDacl(descriptor,out present,out defaultAcl,out defaulted)||!present||defaultAcl==IntPtr.Zero)throw new Win32Exception();
            if(!SetTokenInformation(restricted,6,ref defaultAcl,IntPtr.Size))throw new Win32Exception();
            var stationName="MetaExamCI"+Guid.NewGuid().ToString("N");
            station=CreateWindowStationW(stationName,0,0xF037F,ref desktopSecurity);
            if(station==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateWindowStation");
            var previousStation=GetProcessWindowStation();
            if(!SetProcessWindowStation(station))throw new Win32Exception(Marshal.GetLastWin32Error(),"SetProcessWindowStation");
            try { desktop=CreateDesktopW("tests",IntPtr.Zero,IntPtr.Zero,0,0xF01FF,ref desktopSecurity); }
            finally { if(!SetProcessWindowStation(previousStation))throw new Win32Exception(); }
            if(desktop==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateDesktop");
            var security=new SecurityAttributes{Size=Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=true};
            input=CreateFileW("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);
            output=CreateFileW(outputFile,0x40000000,3,ref security,2,0,IntPtr.Zero);
            if(input==new IntPtr(-1)||output==new IntPtr(-1))throw new Win32Exception();
            var startup=new Startup{Size=Marshal.SizeOf(typeof(Startup)),Desktop=stationName+"\\tests",Flags=0x101,Show=0,Input=input,Output=output,Error=output}; ProcessInfo child;
            // Explicit inheritable file/NUL handles also work on runners without a
            // desktop console. Capture early startup errors before script redirection.
            if(!CreateProcessAsUserW(restricted,executable,new StringBuilder(command),ref desktopSecurity,ref desktopSecurity,true,0x08000000,IntPtr.Zero,cwd,ref startup,out child)) throw new Win32Exception();
            try {
                using(var stream=new FileStream(outputFile,FileMode.Open,FileAccess.Read,FileShare.ReadWrite))
                using(var reader=new StreamReader(stream,Encoding.UTF8)) {
                    uint state;
                    do {
                        state=WaitForSingleObject(child.Process,250);
                        Console.Write(reader.ReadToEnd());
                        if(state!=0 && state!=258) throw new Win32Exception();
                    } while(state==258);
                    Console.Write(reader.ReadToEnd());
                }
                uint code; if(!GetExitCodeProcess(child.Process,out code)) throw new Win32Exception(); return (int)code;
            } finally {CloseHandle(child.Thread);CloseHandle(child.Process);}
        } finally {if(desktop!=IntPtr.Zero)CloseDesktop(desktop);if(station!=IntPtr.Zero)CloseWindowStation(station);if(descriptor!=IntPtr.Zero)LocalFree(descriptor);if(input!=IntPtr.Zero&&input!=new IntPtr(-1))CloseHandle(input);if(output!=IntPtr.Zero&&output!=new IntPtr(-1))CloseHandle(output);if(original!=IntPtr.Zero)CloseHandle(original);if(restricted!=IntPtr.Zero)CloseHandle(restricted);Marshal.FreeHGlobal(admin);}
    }
}
