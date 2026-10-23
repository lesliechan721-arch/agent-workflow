param([ValidateSet('run', 'observe', 'stop')][string]$Action = 'run')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Compile fixed system calls with the Windows .NET runtime. No task text is
# executable PowerShell or C# source. A restrictive host must reject this before
# the suspended backend is resumed; no breakaway flag is requested.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class AwSubagentJob {
  const uint CREATE_SUSPENDED = 4, KILL_ON_CLOSE = 0x2000;
  const uint QUERY = 4, TERMINATE = 8, READ_CONTROL = 0x20000;
  const uint SYNCHRONIZE = 0x100000, WAIT_OBJECT_0 = 0, STILL_ACTIVE = 259;
  const uint FAILURE = 250, PARENT_EXITED = 251;

  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public uint Size; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public ushort ShowWindow, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint Pid, Tid; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(ref SecurityAttributes attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimit limits, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int type, ref Accounting accounting, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr value, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string executable, StringBuilder arguments, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(IntPtr handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static IntPtr DuplicateStandard(int kind) {
    IntPtr target;
    Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out target, 0, true, 2), "Duplicate standard handle");
    return target;
  }
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
      result.Append('\\', slashes).Append(character); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  static uint Active(IntPtr job) {
    Accounting value = new Accounting();
    Check(QueryInformationJobObject(job, 1, ref value, (uint)Marshal.SizeOf(value), IntPtr.Zero), "Query job accounting");
    return value.ActiveProcesses;
  }
  static void Empty(IntPtr job, uint code) {
    Check(TerminateJobObject(job, code), "Terminate job");
    Stopwatch timer = Stopwatch.StartNew();
    while (Active(job) != 0) { if (timer.ElapsedMilliseconds > 10000) throw new Exception("The job did not become empty."); Thread.Sleep(10); }
  }
  static IntPtr OpenOwned(string name, string sid, uint access) {
    IntPtr job = OpenJobObject(access | READ_CONTROL, false, name);
    if (job == IntPtr.Zero) { int code = Marshal.GetLastWin32Error(); if (code == 2) return IntPtr.Zero; throw new Win32Exception(code, "Open job"); }
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error = GetSecurityInfo(job, 6, 5, out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0) { CloseHandle(job); throw new Win32Exception((int)error, "Read job ownership"); }
    try {
      ushort control; uint revision;
      Check(GetSecurityDescriptorControl(descriptor, out control, out revision), "Read job access control");
      if (new SecurityIdentifier(owner).Value != sid || (control & 0x1000) == 0) throw new Exception("The job ownership or access control is unsafe.");
      return job;
    } catch { CloseHandle(job); throw; } finally { LocalFree(descriptor); }
  }
  public static int[] Inspect(string name, string sid, bool stop) {
    IntPtr job = OpenOwned(name, sid, QUERY | (stop ? TERMINATE : 0));
    if (job == IntPtr.Zero) return new int[0];
    try {
      if (stop) { Empty(job, FAILURE); return new int[0]; }
      int capacity = 128;
      for (int attempt = 0; attempt < 8; attempt++) {
        int bytes = 8 + capacity * IntPtr.Size; IntPtr buffer = Marshal.AllocHGlobal(bytes);
        try {
          if (!QueryInformationJobObject(job, 3, buffer, (uint)bytes, IntPtr.Zero)) {
            int error = Marshal.GetLastWin32Error(); if (error == 234) { capacity *= 4; continue; }
            throw new Win32Exception(error, "Query job processes");
          }
          int count = Marshal.ReadInt32(buffer, 4); int[] pids = new int[count];
          for (int i = 0; i < count; i++) pids[i] = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
          return pids;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new Exception("The job process list could not be observed.");
    } finally { CloseHandle(job); }
  }
  public static uint Run(string executable, string[] arguments, uint parentPid, string name, string status) {
    IntPtr parent = OpenProcess(SYNCHRONIZE, false, parentPid);
    if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open parent process");
    IntPtr job = IntPtr.Zero, descriptor = IntPtr.Zero; ProcessInformation child = new ProcessInformation(); bool resumed = false;
    try {
      string sid = WindowsIdentity.GetCurrent().User.Value;
      Check(ConvertStringSecurityDescriptorToSecurityDescriptor("O:" + sid + "D:P(A;;GA;;;" + sid + ")", 1, out descriptor, IntPtr.Zero), "Create private job access control");
      SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, Inherit = false };
      job = CreateJobObject(ref attributes, name); int createError = Marshal.GetLastWin32Error();
      if (job == IntPtr.Zero) throw new Win32Exception(createError, "Create job");
      if (createError == 183) throw new Exception("The private job name is already in use.");
      ExtendedLimit limit = new ExtendedLimit(); limit.Basic.Flags = KILL_ON_CLOSE;
      Check(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(limit)), "Set kill-on-close job limit");
      IntPtr input = DuplicateStandard(-10), output = IntPtr.Zero, error = IntPtr.Zero;
      try {
        output = DuplicateStandard(-11); error = DuplicateStandard(-12);
        StartupInfo startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x100, Input = input, Output = output, Error = error };
        StringBuilder command = new StringBuilder(Quote(executable));
        foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
        Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref startup, out child), "Create suspended backend");
      } finally { CloseHandle(input); if (output != IntPtr.Zero) CloseHandle(output); if (error != IntPtr.Zero) CloseHandle(error); }
      Check(AssignProcessToJobObject(job, child.Process), "Assign backend to job");
      // The parent can submit data only after it reads this private handshake.
      File.WriteAllText(status, "{\"ready\":true,\"pid\":" + child.Pid + "}", new UTF8Encoding(false));
      if (ResumeThread(child.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "Resume backend");
      resumed = true;
      while (true) {
        uint state = WaitForSingleObject(child.Process, 10);
        if (state == WAIT_OBJECT_0) {
          uint code; Check(GetExitCodeProcess(child.Process, out code), "Read backend exit code");
          Empty(job, FAILURE); return code;
        }
        if (state != 258) throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait for backend");
        if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) { Empty(job, PARENT_EXITED); return PARENT_EXITED; }
      }
    } finally {
      if (!resumed && child.Process != IntPtr.Zero) { TerminateProcess(child.Process, FAILURE); WaitForSingleObject(child.Process, 10000); }
      if (job != IntPtr.Zero) CloseHandle(job);
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
      CloseHandle(parent);
    }
  }
}
'@

try {
  if ($Action -eq 'run') {
    $config = [IO.File]::ReadAllText($env:AW_SUBAGENT_JOB_CONFIG, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Remove-Item -LiteralPath $env:AW_SUBAGENT_JOB_CONFIG
    $code = [AwSubagentJob]::Run($config.executable, [string[]]$config.args, [uint32]$config.parentPid, $config.name, $config.status)
    [Environment]::Exit([int]$code)
  } else {
    $config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AW_SUBAGENT_JOB_CONTROL)) | ConvertFrom-Json
    [int[]]$pids = [AwSubagentJob]::Inspect($config.name, $config.sid, ($Action -eq 'stop'))
    if ($null -eq $pids -or $pids.Count -eq 0) { [Console]::Out.WriteLine('[]') }
    else { ConvertTo-Json -InputObject @($pids) -Compress }
  }
} catch {
  [Console]::Error.WriteLine('windowsJobFailed: The native job boundary could not be established or verified.')
  [Environment]::Exit(250)
}
