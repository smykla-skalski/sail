param([Parameter(Mandatory = $true)][string]$SpecPath)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class ContextEvalJob
{
    private const uint KillOnJobClose = 0x00002000;
    private const int ExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static void AssignCurrentProcess()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
            int size = Marshal.SizeOf(typeof(ExtendedLimits));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, ExtendedLimitInformation, buffer, (uint)size))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally { Marshal.FreeHGlobal(buffer); }

            using (Process current = Process.GetCurrentProcess())
            {
                if (!AssignProcessToJobObject(job, current.Handle))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        catch
        {
            CloseHandle(job);
            throw;
        }

        // The handle stays in this process. Its closure on exit kills the whole job.
    }
}
'@ -Language CSharp

$exitCode = 1
try {
    [ContextEvalJob]::AssignCurrentProcess()
    $spec = Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = [string]$spec.command
    $start.Arguments = [string]$spec.arguments
    $start.WorkingDirectory = [string]$spec.cwd
    $start.UseShellExecute = $false
    $runner = [System.Diagnostics.Process]::Start($start)
    if ($null -eq $runner) { throw 'Cannot start context evaluation runner.' }
    try {
        $runner.WaitForExit()
        $exitCode = $runner.ExitCode
    } finally {
        $runner.Dispose()
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
}

exit $exitCode
