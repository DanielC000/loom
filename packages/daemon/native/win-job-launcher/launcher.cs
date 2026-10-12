// win-job-launcher — Windows-only. Contains a canonical git call (plus whatever a hook forks/double-forks)
// in a Win32 Job Object, closing the taskkill-/T escape documented at docs/decisions/1718416d-*.md.
//
// Three modes, selected by argv[0]:
//   launcher.exe <signalMarker> <nonceHex> <git-args...>   — normal mode (signalMarker is the literal
//                                                             string "run"; see USAGE below)
//   launcher.exe --signal <nonceHex>                        — signal mode: opens the SAME nonce-derived
//                                                             named event and sets it, then exits.
//   launcher.exe --probe <nonceHex>                         — probe mode: opens the SAME nonce-derived
//                                                             named event WITHOUT setting it (a pure
//                                                             existence check), then exits. Exists so a
//                                                             test can wait for a real readiness signal
//                                                             ("has instance A created its event yet?")
//                                                             instead of a fixed sleep — see
//                                                             test/win-job-launcher-event-collision.mjs.
//
// Normal mode never writes anything of its own to stdout/stderr — those handles are inherited by git.exe
// so Node's own read of them must see ONLY git's real output. Every launcher-side outcome is conveyed
// SOLELY through the exit code (see EXIT CODES below); the daemon (git/bounded.ts) interprets it.
//
// EXIT CODES (normal mode):
//   <git's own exit code>  — git ran to completion; this is git's real, unmodified exit status. Git exit
//                            codes are a DWORD but conventionally fit 0-255, so this range never collides
//                            with the launcher-originated codes below (round 2, MAJOR 2 — every
//                            launcher-originated code was moved OUT of 0-255 for exactly this reason: a
//                            git that itself happened to exit 214/215/216/250 used to be indistinguishable
//                            from a launcher verdict).
//   0x4C4F0001 (1280245761) — CONFIRMED: abort was signaled, TerminateJobObject ran, and
//                             ActiveProcesses==0 was observed within the grace window: the WHOLE tree is
//                             confirmed dead.
//   0x4C4F0002 (1280245762) — UNCONFIRMED: abort was signaled, but ActiveProcesses!=0 (or the query
//                             itself failed, or the wait on git/the abort event itself failed) within the
//                             grace window: NOT confirmed — some descendant may still be alive.
//   0x4C4F0003 (1280245763) — REFUSED: git.exe was NEVER spawned (a squatted/collided abort-event name,
//                             a SetInformationJobObject/CreateProcessW/AssignProcessToJobObject failure —
//                             the suspended process, if one was ever created, is TerminateProcess'd before
//                             this returns — or malformed argv). The caller must treat this call as if the
//                             launcher were unavailable and fall back for THIS call only.
//
// All three launcher-originated codes are well below 2^31 (Int32.MaxValue), so they read as ordinary
// positive integers however Node's child_process surfaces a Windows DWORD exit code — never a
// sign-flipped negative one that could be confused with something else (verified by inspection: 0x4C4F0003
// = 1,280,245,763 < 2,147,483,647).
//
// EXIT CODES (--signal mode): 0 = the event was found and set; 1 = found but SetEvent failed; 2 = the
// event never appeared within the short poll window (caller should treat this as "may have missed the
// window" and fall back to its own hard-timeout path).
//
// EXIT CODES (--probe mode): 0 = the event currently exists; 1 = it does not (yet, or ever).
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Launcher
{
    // ---- Win32 P/Invoke surface -------------------------------------------------------------------

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectBasicAccountingInformation = 1;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000; // deliberately ONLY this flag — no
                                                                     // BREAKAWAY_OK/SILENT_BREAKAWAY_OK —
                                                                     // see docs/decisions/1718416d-*.md.

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint exitCode);

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const int STARTF_USESTDHANDLES = 0x00000100;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    private const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;

    [DllImport("kernel32.dll")] private static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll")] private static extern uint WaitForMultipleObjects(uint nCount, IntPtr[] lpHandles, bool bWaitAll, uint dwMilliseconds);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    // round 2, MAJOR 1: terminates a git we created SUSPENDED but could never safely contain (a job-setup
    // failure) — it has run zero instructions, so killing it here loses nothing and leaves no live process.
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x1, FILE_SHARE_WRITE = 0x2;
    private const uint OPEN_EXISTING = 3;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateEventW(ref SECURITY_ATTRIBUTES lpEventAttributes, bool bManualReset, bool bInitialState, string lpName);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenEventW(uint dwDesiredAccess, bool bInheritHandle, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetEvent(IntPtr hEvent);

    private const uint EVENT_MODIFY_STATE = 0x0002;
    // round 2, MINOR b: --probe needs only SYNCHRONIZE (the right to wait on the handle) — it never calls
    // SetEvent, so it deliberately does NOT request EVENT_MODIFY_STATE the way --signal does.
    private const uint SYNCHRONIZE = 0x00100000;
    private const int ERROR_ALREADY_EXISTS = 183;

    private const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_FAILED = 0xFFFFFFFF;

    // ---- Contract constants (see file header) ------------------------------------------------------
    // round 2, MAJOR 2: moved OUT of the 0-255 range git's own exit codes occupy — see the file header's
    // EXIT CODES section for why, and the sign-safety note (all three are well under Int32.MaxValue).
    // EXIT_EVENT_NAME_COLLISION/EXIT_CREATE_PROCESS_FAILED/EXIT_BAD_ARGS (formerly 216/250/251) are GONE:
    // every "git never ran" refusal now reports the SAME EXIT_REFUSED — bounded.ts only ever needed to
    // know "fall back for this call", never which specific refusal reason, so collapsing them removes a
    // distinction with no caller-visible difference rather than hiding one.

    private const int EXIT_CONFIRMED_KILLED = 0x4C4F0001;
    private const int EXIT_UNCONFIRMED_KILLED = 0x4C4F0002;
    private const int EXIT_REFUSED = 0x4C4F0003;

    // Bounded poll for ActiveProcesses==0 after TerminateJobObject — same shape/budget as the STEP 0b
    // prototype's own verified-reliable grace window (25 * 200ms = 5s).
    private const int TERMINATE_CONFIRM_POLL_COUNT = 25;
    private const int TERMINATE_CONFIRM_POLL_INTERVAL_MS = 200;

    // A bare "git.exe" token, never an absolute path: with lpApplicationName null, CreateProcessW's own
    // documented search sequence (app dir, current dir, system dirs, then every entry of PATH) resolves
    // it — the SAME PATH value Node already passed this launcher via its own `env` spawn option, so this
    // resolves to the IDENTICAL binary today's bare spawn("git", ...) would have found. No node-pty-style
    // "doesn't search PATH" limitation applies here — that is specific to node-pty's own spawn mechanism,
    // not a general CreateProcessW constraint (verified against the documented search order).
    private const string GitExePath = "git.exe";

    private static string EventNameFor(string nonceHex) { return "Local\\LoomWinJobAbort_" + nonceHex; }

    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--signal")
        {
            return RunSignalMode(args[1]);
        }
        if (args.Length >= 2 && args[0] == "--probe")
        {
            return RunProbeMode(args[1]);
        }
        if (args.Length < 2 || args[0] != "run")
        {
            return EXIT_REFUSED; // malformed argv — git was never spawned; same fallback posture as
                                  // every other refusal (round 2, MAJOR 2: formerly a distinct 251).
        }
        string nonceHex = args[1];
        string[] gitArgs = new string[args.Length - 2];
        Array.Copy(args, 2, gitArgs, 0, gitArgs.Length);
        return RunMode(nonceHex, gitArgs);
    }

    private static int RunSignalMode(string nonceHex)
    {
        string eventName = EventNameFor(nonceHex);
        for (int i = 0; i < 40; i++) // ~400ms total — the launcher creates its event before doing
        {                            // anything else observable, so this should hit on the first try.
            IntPtr h = OpenEventW(EVENT_MODIFY_STATE, false, eventName);
            if (h != IntPtr.Zero)
            {
                bool ok = SetEvent(h);
                CloseHandle(h);
                return ok ? 0 : 1;
            }
            Thread.Sleep(10);
        }
        return 2;
    }

    // round 2, MINOR b: a pure existence check — never calls SetEvent, so unlike --signal this can be
    // polled repeatedly with no side effect on the instance it's checking. Exists so a test waiting for
    // "has instance A created its event yet?" can poll a real readiness signal instead of a fixed sleep.
    private static int RunProbeMode(string nonceHex)
    {
        string eventName = EventNameFor(nonceHex);
        IntPtr h = OpenEventW(SYNCHRONIZE, false, eventName);
        if (h != IntPtr.Zero)
        {
            CloseHandle(h);
            return 0;
        }
        return 1;
    }

    private static int RunMode(string nonceHex, string[] gitArgs)
    {
        IntPtr hJob = CreateJobObjectW(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero) return EXIT_REFUSED;
        var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // round 2, MAJOR 1: this result was previously ignored — if it fails, the job never actually
        // carries the KILL_ON_JOB_CLOSE limit, so an eventual TerminateJobObject+ActiveProcesses==0
        // "confirmation" would be meaningless (the job closing would kill nothing). Refuse before git
        // is ever spawned, same as every other setup failure below.
        if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ref ext, (uint)Marshal.SizeOf(ext)))
        {
            CloseHandle(hJob);
            return EXIT_REFUSED;
        }

        // The abort event is created FIRST, before git is ever spawned — a squatted/collided name must
        // refuse the whole call, never race a half-started git.
        string eventName = EventNameFor(nonceHex);
        var saEvent = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = false };
        IntPtr hAbortEvent = CreateEventW(ref saEvent, false, false, eventName);
        if (hAbortEvent == IntPtr.Zero || Marshal.GetLastWin32Error() == ERROR_ALREADY_EXISTS)
        {
            if (hAbortEvent != IntPtr.Zero) CloseHandle(hAbortEvent);
            CloseHandle(hJob);
            return EXIT_REFUSED;
        }

        // git's OWN stdin is NUL — never this launcher's inherited stdin. Sharing that handle causes a
        // Windows/MSYS startup hang (a pending synchronous read on a pipe serializes other I/O on the same
        // file object, including the MSYS runtime's own startup stdin probes) — see
        // docs/decisions/1718416d-*.md for the full mechanism and how it was isolated.
        var saNul = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
        IntPtr hNul = CreateFileW("NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, ref saNul, OPEN_EXISTING, 0, IntPtr.Zero);
        IntPtr hOut = GetStdHandle(STD_OUTPUT_HANDLE);
        IntPtr hErr = GetStdHandle(STD_ERROR_HANDLE);

        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = hNul;
        si.StartupInfo.hStdOutput = hOut;
        si.StartupInfo.hStdError = hErr;

        // Explicit handle-inheritance list: ONLY these 3 handles reach git.exe — never whatever else this
        // launcher happens to have inherited from Node (ruled out during STEP 0b as the hang's cause, but
        // kept as the correct, minimal-surface way to hand a child exactly the handles it needs).
        IntPtr[] handles = { hNul, hOut, hErr };
        int handleArraySize = IntPtr.Size * handles.Length;
        IntPtr handleArrayPtr = Marshal.AllocHGlobal(handleArraySize);
        IntPtr attrList = IntPtr.Zero;
        try
        {
            Marshal.Copy(handles, 0, handleArrayPtr, handles.Length);
            IntPtr attrListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrListSize);
            attrList = Marshal.AllocHGlobal(attrListSize);
            InitializeProcThreadAttributeList(attrList, 1, 0, ref attrListSize);
            UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleArrayPtr, (IntPtr)handleArraySize, IntPtr.Zero, IntPtr.Zero);
            si.lpAttributeList = attrList;

            StringBuilder cmdLine = new StringBuilder();
            cmdLine.Append(QuoteWindowsArg(GitExePath));
            foreach (var a in gitArgs) { cmdLine.Append(' '); cmdLine.Append(QuoteWindowsArg(a)); }

            PROCESS_INFORMATION pi;
            bool created = CreateProcessW(null, cmdLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref si, out pi);
            if (!created)
            {
                CloseHandle(hAbortEvent);
                CloseHandle(hJob);
                return EXIT_REFUSED;
            }

            // round 2, MAJOR 1: this result was previously IGNORED — an assign failure left git running
            // SUSPENDED-then-resumed OUTSIDE the job (ActiveProcesses would read 0 even with git's whole
            // tree alive, so a later abort would wrongly report EXIT_CONFIRMED_KILLED: the job it
            // terminates is empty, confirming nothing). git has not yet run a single instruction (still
            // suspended) — kill it outright and refuse the call rather than resume it uncontained.
            bool assigned = AssignProcessToJobObject(hJob, pi.hProcess);
            if (!assigned)
            {
                TerminateProcess(pi.hProcess, 0);
                WaitForSingleObject(pi.hProcess, 5000); // bounded: best-effort confirm the kill landed
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(hAbortEvent);
                CloseHandle(hJob);
                return EXIT_REFUSED;
            }
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);

            IntPtr[] waitHandles = { pi.hProcess, hAbortEvent };
            while (true)
            {
                uint waitResult = WaitForMultipleObjects(2, waitHandles, false, 200);
                if (waitResult == WAIT_OBJECT_0)
                {
                    uint exitCode;
                    // round 2, MAJOR 1: GetExitCodeProcess's own return was previously ignored — on
                    // failure `exitCode` is not reliably git's real status, so returning it as-is risks
                    // fabricating a 0-255 value that LOOKS like a real git exit code but isn't one. Fail
                    // toward unconfirmed instead (never a fabricated 0-255 value on this branch).
                    bool gotExit = GetExitCodeProcess(pi.hProcess, out exitCode);
                    CloseHandle(pi.hProcess);
                    CloseHandle(hJob);
                    CloseHandle(hAbortEvent);
                    if (!gotExit) return EXIT_UNCONFIRMED_KILLED;
                    return (int)exitCode;
                }
                if (waitResult == WAIT_OBJECT_0 + 1)
                {
                    TerminateJobObject(hJob, 1);
                    bool confirmed = false;
                    for (int i = 0; i < TERMINATE_CONFIRM_POLL_COUNT; i++)
                    {
                        var acct = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
                        bool qOk = QueryInformationJobObject(hJob, JobObjectBasicAccountingInformation, ref acct, (uint)Marshal.SizeOf(acct), IntPtr.Zero);
                        if (qOk && acct.ActiveProcesses == 0) { confirmed = true; break; }
                        Thread.Sleep(TERMINATE_CONFIRM_POLL_INTERVAL_MS);
                    }
                    CloseHandle(pi.hProcess);
                    CloseHandle(hJob);
                    CloseHandle(hAbortEvent);
                    return confirmed ? EXIT_CONFIRMED_KILLED : EXIT_UNCONFIRMED_KILLED;
                }
                if (waitResult == WAIT_FAILED)
                {
                    // round 2, MAJOR 1: previously unhandled — any value other than the two WAIT_OBJECT_0
                    // cases fell through to the "WAIT_TIMEOUT: loop again" comment with no actual timeout
                    // check, spinning forever at 0% progress on a genuine wait failure. Give up safely:
                    // best-effort terminate the job (closing hJob below also fires KILL_ON_JOB_CLOSE
                    // regardless) and report unconfirmed rather than hang.
                    TerminateJobObject(hJob, 1);
                    CloseHandle(pi.hProcess);
                    CloseHandle(hJob);
                    CloseHandle(hAbortEvent);
                    return EXIT_UNCONFIRMED_KILLED;
                }
                // WAIT_TIMEOUT (258): loop again.
            }
        }
        finally
        {
            if (attrList != IntPtr.Zero) { DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList); }
            Marshal.FreeHGlobal(handleArrayPtr);
        }
    }

    /// <summary>
    /// The documented CommandLineToArgvW-inverse quoting algorithm (Microsoft's own C runtime source;
    /// the same shape .NET's own ProcessStartInfo.ArgumentList uses internally on Windows). NOT the naive
    /// "wrap in quotes and escape embedded quotes" approach — that mishandles a run of backslashes
    /// immediately preceding a quote or the argument's own end. See
    /// test/win-job-launcher-fidelity.mjs for the fidelity matrix this must satisfy byte-for-byte.
    /// </summary>
    private static string QuoteWindowsArg(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        var sb = new StringBuilder();
        sb.Append('"');
        for (int i = 0; i < arg.Length; i++)
        {
            int backslashes = 0;
            while (i < arg.Length && arg[i] == '\\') { backslashes++; i++; }
            if (i == arg.Length)
            {
                sb.Append('\\', backslashes * 2);
                break;
            }
            else if (arg[i] == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
            }
            else
            {
                sb.Append('\\', backslashes);
                sb.Append(arg[i]);
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
