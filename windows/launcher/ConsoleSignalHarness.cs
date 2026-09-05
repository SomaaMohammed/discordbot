using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class ConsoleSignalHarness
{
    private const uint CreateNewConsole = 0x00000010;
    private const uint StartfUseShowWindow = 0x00000001;
    private const uint StartfUseStdHandles = 0x00000100;
    private const short SwHide = 0;
    private const uint CtrlCEvent = 0;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint Th32csSnapProcess = 0x00000002;
    private const uint ProcessQueryLimitedInformation = 0x00001000;
    private const uint Synchronize = 0x00100000;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    private static int Main(string[] args)
    {
        if (args.Length != 5)
        {
            Console.Error.WriteLine(
                "Usage: ConsoleSignalHarness <exe> <working-dir> <output> <ready-text> <runtime-exe>"
            );
            return 2;
        }

        try
        {
            return Run(args[0], args[1], args[2], args[3], args[4]);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static int Run(
        string executable,
        string workingDirectory,
        string outputFile,
        string readyText,
        string expectedRuntime
    )
    {
        executable = Path.GetFullPath(executable);
        workingDirectory = Path.GetFullPath(workingDirectory);
        outputFile = Path.GetFullPath(outputFile);
        expectedRuntime = Path.GetFullPath(expectedRuntime);
        if (!File.Exists(executable) || !Directory.Exists(workingDirectory))
        {
            throw new InvalidOperationException("The Ctrl+C smoke-test target is missing.");
        }

        using (FileStream output = new FileStream(
            outputFile,
            FileMode.Create,
            FileAccess.Write,
            FileShare.ReadWrite
        ))
        {
            IntPtr outputHandle = output.SafeFileHandle.DangerousGetHandle();
            if (!SetHandleInformation(outputHandle, HandleFlagInherit, HandleFlagInherit))
            {
                throw NewWindowsError("Could not make the smoke-test log inheritable");
            }

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = StartfUseShowWindow | StartfUseStdHandles;
            startup.wShowWindow = SwHide;
            startup.hStdOutput = outputHandle;
            startup.hStdError = outputHandle;
            startup.hStdInput = GetStdHandle(-10);
            PROCESS_INFORMATION process;
            StringBuilder commandLine = new StringBuilder(
                Quote(executable) + " --offline-smoke"
            );
            if (
                !CreateProcess(
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CreateNewConsole,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startup,
                    out process
                )
            )
            {
                throw NewWindowsError("Could not start the isolated Ctrl+C smoke test");
            }

            CloseHandle(process.hThread);
            IntPtr childProcess = IntPtr.Zero;
            try
            {
                WaitForReady(process.hProcess, outputFile, readyText);
                childProcess = AssertCompiledChild(process.dwProcessId, expectedRuntime);

                if (!FreeConsole())
                {
                    throw NewWindowsError("Could not detach the signal harness console");
                }
                try
                {
                    if (!AttachConsole(process.dwProcessId))
                    {
                        throw NewWindowsError("Could not attach to the launcher console");
                    }
                    if (!SetConsoleCtrlHandler(IntPtr.Zero, true))
                    {
                        throw NewWindowsError("Could not protect the signal harness from Ctrl+C");
                    }
                    if (!GenerateConsoleCtrlEvent(CtrlCEvent, 0))
                    {
                        throw NewWindowsError("Could not send Ctrl+C to the launcher");
                    }
                    Thread.Sleep(250);
                }
                finally
                {
                    FreeConsole();
                }

                uint wait = WaitForSingleObject(process.hProcess, 15000);
                if (wait == WaitTimeout)
                {
                    TerminateProcess(process.hProcess, 125);
                    throw new TimeoutException("Launcher did not stop within 15 seconds after Ctrl+C.");
                }
                if (wait != WaitObject0)
                {
                    throw NewWindowsError("Waiting for the Ctrl+C smoke test failed");
                }
                uint childWait = WaitForSingleObject(childProcess, 15000);
                if (childWait == WaitTimeout)
                {
                    throw new TimeoutException("Compiled runtime remained alive after launcher shutdown.");
                }
                if (childWait != WaitObject0)
                {
                    throw NewWindowsError("Waiting for the compiled runtime failed");
                }
                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode))
                {
                    throw NewWindowsError("Could not read the Ctrl+C smoke-test exit code");
                }
                output.Flush(true);
                string captured = ReadSharedText(outputFile);
                if (exitCode != 0 || !captured.Contains("graceful shutdown complete"))
                {
                    throw new InvalidOperationException(
                        "The compiled runtime did not complete graceful Ctrl+C shutdown.\n"
                            + captured
                    );
                }
                return 0;
            }
            finally
            {
                StopIfRunning(childProcess, 126);
                if (childProcess != IntPtr.Zero)
                {
                    CloseHandle(childProcess);
                }
                StopIfRunning(process.hProcess, 127);
                CloseHandle(process.hProcess);
            }
        }
    }

    private static void WaitForReady(IntPtr process, string outputFile, string readyText)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (WaitForSingleObject(process, 0) == WaitObject0)
            {
                throw new InvalidOperationException(
                    "Launcher exited before its offline readiness marker.\n"
                        + ReadSharedText(outputFile)
                );
            }
            if (ContainsReadyLine(ReadSharedText(outputFile), readyText))
            {
                return;
            }
            Thread.Sleep(50);
        }
        TerminateProcess(process, 124);
        throw new TimeoutException("Timed out waiting for offline readiness.");
    }

    private static string ReadSharedText(string outputFile)
    {
        using (FileStream input = new FileStream(
            outputFile,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete
        ))
        using (StreamReader reader = new StreamReader(input, Encoding.UTF8, true))
        {
            return reader.ReadToEnd();
        }
    }

    private static IntPtr AssertCompiledChild(uint launcherProcessId, string expectedRuntime)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == InvalidHandleValue)
        {
            throw NewWindowsError("Could not inspect the packaged process tree");
        }
        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            IntPtr runtimeProcess = IntPtr.Zero;
            if (!Process32First(snapshot, ref entry))
            {
                throw NewWindowsError("Could not read the packaged process tree");
            }
            do
            {
                if (entry.th32ParentProcessID != launcherProcessId)
                {
                    continue;
                }
                if (
                    string.Equals(
                        entry.szExeFile,
                        "SuperiorBot.Runtime.exe",
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                {
                    if (runtimeProcess != IntPtr.Zero)
                    {
                        throw new InvalidOperationException("The launcher started more than one compiled runtime.");
                    }
                    runtimeProcess = OpenProcess(
                        Synchronize | ProcessQueryLimitedInformation,
                        false,
                        entry.th32ProcessID
                    );
                    if (runtimeProcess == IntPtr.Zero)
                    {
                        throw NewWindowsError("Could not open the compiled runtime process");
                    }
                    StringBuilder imagePath = new StringBuilder(32768);
                    int imagePathLength = imagePath.Capacity;
                    if (!QueryFullProcessImageName(runtimeProcess, 0, imagePath, ref imagePathLength))
                    {
                        CloseHandle(runtimeProcess);
                        throw NewWindowsError("Could not resolve the compiled runtime image path");
                    }
                    if (!string.Equals(
                        Path.GetFullPath(imagePath.ToString()),
                        expectedRuntime,
                        StringComparison.OrdinalIgnoreCase
                    ))
                    {
                        CloseHandle(runtimeProcess);
                        throw new InvalidOperationException(
                            "The launcher started an unexpected compiled runtime path: " + imagePath
                        );
                    }
                }
                else if (!string.Equals(
                    entry.szExeFile,
                    "conhost.exe",
                    StringComparison.OrdinalIgnoreCase
                ))
                {
                    throw new InvalidOperationException(
                        "The launcher started an unexpected child process: " + entry.szExeFile
                    );
                }
            }
            while (Process32Next(snapshot, ref entry));

            if (runtimeProcess == IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    "The launcher did not start SuperiorBot.Runtime.exe directly."
                );
            }
            return runtimeProcess;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    private static bool ContainsReadyLine(string output, string readyText)
    {
        string[] lines = output.Replace("\r\n", "\n").Split('\n');
        foreach (string line in lines)
        {
            if (line.StartsWith(readyText, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }

    private static void StopIfRunning(IntPtr process, uint exitCode)
    {
        if (process != IntPtr.Zero && WaitForSingleObject(process, 0) == WaitTimeout)
        {
            TerminateProcess(process, exitCode);
            WaitForSingleObject(process, 5000);
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static Win32Exception NewWindowsError(string message)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), message);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process,
        uint flags,
        StringBuilder executableName,
        ref int size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }
}
