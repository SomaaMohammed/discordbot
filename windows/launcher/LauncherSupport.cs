using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class LauncherSupport
{
    public static string NormalizeRoot(string root)
    {
        return Path.GetFullPath(root).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        );
    }

    public static bool EqualsOption(string value, string expected)
    {
        return string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);
    }

    public static string VerifyPayloadVersion(string payloadRoot)
    {
        string versionFile = Path.Combine(payloadRoot, "VERSION");
        if (!File.Exists(versionFile))
        {
            throw new InvalidDataException("The application payload has no VERSION identity file.");
        }
        string version = File.ReadAllText(versionFile).Trim();
        if (!string.Equals(version, BuildIdentity.Version, StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                "The launcher and application payload versions do not match. "
                    + "Replace the executable with one complete verified release."
            );
        }
        return version;
    }

    public static string ReadSourceIdentity(string payloadRoot)
    {
        string buildInfo = Path.Combine(payloadRoot, "BUILD-INFO.txt");
        if (!File.Exists(buildInfo))
        {
            throw new InvalidDataException("The application payload has no build identity.");
        }
        foreach (string line in File.ReadAllLines(buildInfo))
        {
            const string prefix = "SOURCE_SHA256=";
            if (line.StartsWith(prefix, StringComparison.Ordinal))
            {
                string value = line.Substring(prefix.Length).Trim();
                if (IsLowerHexSha256(value))
                {
                    return value;
                }
            }
        }
        throw new InvalidDataException("The application payload source identity is missing.");
    }

    public static void ValidatePortableManifest(string payloadRoot)
    {
        string normalizedRoot = NormalizeRoot(payloadRoot);
        string rootPrefix = normalizedRoot + Path.DirectorySeparatorChar;
        string manifest = Path.Combine(normalizedRoot, "MANIFEST.sha256");
        if (!File.Exists(manifest))
        {
            throw new InvalidDataException("The application payload manifest is missing.");
        }
        RefuseReparsePoint(normalizedRoot, "The portable application root");
        RefuseReparsePoint(manifest, "The application payload manifest");
        Dictionary<string, string> expected = new Dictionary<string, string>(
            StringComparer.OrdinalIgnoreCase
        );
        foreach (string line in File.ReadAllLines(manifest))
        {
            if (line.Length < 67 || line.Substring(64, 2) != "  ")
            {
                throw new InvalidDataException("The application payload manifest is malformed.");
            }
            string hash = line.Substring(0, 64);
            if (!IsLowerHexSha256(hash))
            {
                throw new InvalidDataException("The application payload manifest contains an invalid hash.");
            }
            string relative = line.Substring(66).Replace('/', Path.DirectorySeparatorChar);
            string fileName = Path.GetFullPath(Path.Combine(normalizedRoot, relative));
            if (!fileName.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("The application payload manifest contains an unsafe path.");
            }
            string canonicalRelative = fileName.Substring(rootPrefix.Length);
            if (expected.ContainsKey(canonicalRelative))
            {
                throw new InvalidDataException("The application payload manifest contains a duplicate path.");
            }
            RefuseReparsePoint(fileName, "A declared application payload file");
            if (!File.Exists(fileName) || ComputeSha256(fileName) != hash)
            {
                throw new InvalidDataException(
                    "The application payload failed its integrity check: " + canonicalRelative
                );
            }
            expected.Add(canonicalRelative, hash);
        }

        // The portable root is also the documented writable application root,
        // so operator-owned .env, SQLite, backup, and diagnostic files are
        // intentionally outside the immutable manifest boundary. Keep the
        // executable payload directories closed to undeclared files.
        List<string> actual = new List<string>();
        foreach (string directoryName in new string[] { "app", "runtime", "tools" })
        {
            string directory = Path.Combine(normalizedRoot, directoryName);
            if (!Directory.Exists(directory))
            {
                throw new InvalidDataException(
                    "The application payload directory is missing: " + directoryName
                );
            }
            ValidateTreeHasNoReparsePoints(directory);
            CollectFiles(normalizedRoot, directory, actual);
        }
        foreach (string relative in actual)
        {
            if (!expected.ContainsKey(relative))
            {
                throw new InvalidDataException(
                    "The application payload contains an undeclared file: " + relative
                );
            }
        }
    }

    public static string ComputeSha256(string fileName)
    {
        using (SHA256 sha256 = SHA256.Create())
        using (FileStream stream = File.OpenRead(fileName))
        {
            byte[] hash = sha256.ComputeHash(stream);
            return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
        }
    }

    public static string ResolveEnvironmentFile(string applicationRoot)
    {
        string configured = Environment.GetEnvironmentVariable("ENV_FILE");
        if (string.IsNullOrWhiteSpace(configured))
        {
            return Path.Combine(applicationRoot, ".env");
        }
        return Path.IsPathRooted(configured)
            ? Path.GetFullPath(configured)
            : Path.GetFullPath(Path.Combine(applicationRoot, configured));
    }

    public static string ResolveDatabaseFile(string applicationRoot, string environmentFile)
    {
        string configured = Environment.GetEnvironmentVariable("DB_FILE");
        if (string.IsNullOrWhiteSpace(configured) && File.Exists(environmentFile))
        {
            configured = ReadDotEnvValue(environmentFile, "DB_FILE");
        }
        if (string.IsNullOrWhiteSpace(configured))
        {
            configured = "superior.db";
        }
        configured = configured.Trim();
        return Path.IsPathRooted(configured)
            ? Path.GetFullPath(configured)
            : Path.GetFullPath(Path.Combine(applicationRoot, configured));
    }

    public static SuperiorInstanceGuard AcquireInstanceGuard(
        string applicationRoot,
        string environmentFile
    )
    {
        string normalizedRoot = NormalizeRoot(applicationRoot);
        string databaseFile = ResolveDatabaseFile(normalizedRoot, environmentFile);
        return SuperiorInstanceGuard.Acquire(normalizedRoot, databaseFile);
    }

    public static void Log(string level, string message)
    {
        Console.WriteLine(
            DateTimeOffset.UtcNow.ToString("O")
                + " ["
                + SafeField(level, 16)
                + "] [launcher] "
                + SafeField(message, 2048)
        );
    }

    public static string SafeField(string value, int maximumLength)
    {
        if (value == null)
        {
            return "";
        }
        StringBuilder result = new StringBuilder(Math.Min(value.Length, maximumLength));
        foreach (char character in value)
        {
            if (result.Length >= maximumLength)
            {
                break;
            }
            result.Append(char.IsControl(character) ? ' ' : character);
        }
        if (value.Length > maximumLength)
        {
            result.Append("...");
        }
        return result.ToString();
    }

    public static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    public static int RunChild(ProcessStartInfo start)
    {
        using (SuperiorChildJob childJob = SuperiorChildJob.Create())
        using (Process process = Process.Start(start))
        {
            if (process == null)
            {
                throw new InvalidOperationException("Unable to start the bundled Node runtime.");
            }

            try
            {
                childJob.Assign(process);
            }
            catch
            {
                if (!process.HasExited)
                {
                    try
                    {
                        process.Kill();
                        process.WaitForExit();
                    }
                    catch
                    {
                        // The original job-assignment failure is the useful error.
                    }
                }
                throw;
            }

            int cancellationCount = 0;
            ConsoleCancelEventHandler cancellationHandler = (sender, eventArguments) =>
            {
                int current = Interlocked.Increment(ref cancellationCount);
                if (current == 1)
                {
                    eventArguments.Cancel = true;
                    Log(
                        "INFO",
                        "Shutdown signal received; waiting for the bundled Node process to drain. Press Ctrl+C again to force termination."
                    );
                    return;
                }

                eventArguments.Cancel = false;
                Log(
                    "WARN",
                    "A second shutdown signal will force launcher exit; the child job will terminate the bundled Node process."
                );
            };
            Console.CancelKeyPress += cancellationHandler;
            try
            {
                process.WaitForExit();
                return process.ExitCode;
            }
            finally
            {
                Console.CancelKeyPress -= cancellationHandler;
            }
        }
    }

    public static void RefuseReparsePoint(string path, string description)
    {
        if (
            File.Exists(path)
            || Directory.Exists(path)
        )
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException(description + " must not be a reparse point.");
            }
        }
    }

    public static void ValidateTreeHasNoReparsePoints(string root)
    {
        RefuseReparsePoint(root, "The private runtime cache");
        ValidateDirectoryEntries(root);
    }

    private static void ValidateDirectoryEntries(string directory)
    {
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            RefuseReparsePoint(entry, "A private runtime cache entry");
            if (Directory.Exists(entry))
            {
                ValidateDirectoryEntries(entry);
            }
        }
    }

    private static void CollectFiles(string root, string directory, List<string> results)
    {
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            RefuseReparsePoint(entry, "An application payload entry");
            if (Directory.Exists(entry))
            {
                CollectFiles(root, entry, results);
            }
            else
            {
                results.Add(entry.Substring(root.Length + 1));
            }
        }
    }

    private static bool IsLowerHexSha256(string value)
    {
        if (value.Length != 64)
        {
            return false;
        }
        foreach (char character in value)
        {
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
            {
                return false;
            }
        }
        return true;
    }

    private static string ReadDotEnvValue(string environmentFile, string key)
    {
        if (new FileInfo(environmentFile).Length > 1048576)
        {
            throw new InvalidDataException(
                "The selected environment file is too large to inspect safely."
            );
        }
        foreach (string rawLine in File.ReadAllLines(environmentFile))
        {
            string line = rawLine.Trim();
            if (line.StartsWith("export ", StringComparison.Ordinal))
            {
                line = line.Substring(7).TrimStart();
            }
            int separator = line.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }
            if (!string.Equals(line.Substring(0, separator).Trim(), key, StringComparison.Ordinal))
            {
                continue;
            }
            string value = line.Substring(separator + 1).Trim();
            if (
                value.Length >= 2
                && ((value[0] == '\"' && value[value.Length - 1] == '\"')
                    || (value[0] == '\'' && value[value.Length - 1] == '\''))
            )
            {
                value = value.Substring(1, value.Length - 2);
            }
            else
            {
                int comment = value.IndexOf(" #", StringComparison.Ordinal);
                if (comment >= 0)
                {
                    value = value.Substring(0, comment).TrimEnd();
                }
            }
            return value;
        }
        return null;
    }
}

internal sealed class SuperiorChildJob : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    private IntPtr handle;

    private SuperiorChildJob(IntPtr handle)
    {
        this.handle = handle;
    }

    public static SuperiorChildJob Create()
    {
        IntPtr handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero)
        {
            throw NewWindowsError("Superior Bot could not create its child-process safety job");
        }

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
            new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        if (
            !SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                ref information,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))
            )
        )
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(handle);
            throw NewWindowsError(
                "Superior Bot could not configure its child-process safety job",
                error
            );
        }
        return new SuperiorChildJob(handle);
    }

    public void Assign(Process process)
    {
        if (handle == IntPtr.Zero)
        {
            throw new ObjectDisposedException("SuperiorChildJob");
        }
        if (!AssignProcessToJobObject(handle, process.Handle))
        {
            throw NewWindowsError(
                "Superior Bot could not attach the bundled Node process to its safety job"
            );
        }
    }

    public void Dispose()
    {
        IntPtr current = Interlocked.Exchange(ref handle, IntPtr.Zero);
        if (current != IntPtr.Zero)
        {
            CloseHandle(current);
        }
    }

    private static Win32Exception NewWindowsError(string message)
    {
        return NewWindowsError(message, Marshal.GetLastWin32Error());
    }

    private static Win32Exception NewWindowsError(string message, int error)
    {
        return new Win32Exception(
            error,
            message + ". Stop any existing child process and retry without elevation."
        );
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

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
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}

internal sealed class SuperiorInstanceGuard : IDisposable
{
    private readonly List<Mutex> mutexes;
    private bool disposed;

    private SuperiorInstanceGuard(List<Mutex> mutexes)
    {
        this.mutexes = mutexes;
    }

    public static SuperiorInstanceGuard Acquire(string applicationRoot, string databaseFile)
    {
        List<KeyValuePair<string, string>> targets = new List<KeyValuePair<string, string>>
        {
            new KeyValuePair<string, string>("application root", applicationRoot),
            new KeyValuePair<string, string>("database", databaseFile)
        };
        targets.Sort((left, right) =>
            string.Compare(BuildMutexName(left.Key, left.Value), BuildMutexName(right.Key, right.Value), StringComparison.Ordinal)
        );

        List<Mutex> acquired = new List<Mutex>();
        try
        {
            foreach (KeyValuePair<string, string> target in targets)
            {
                Mutex mutex;
                try
                {
                    mutex = new Mutex(false, BuildMutexName(target.Key, target.Value));
                }
                catch (UnauthorizedAccessException error)
                {
                    throw new InvalidOperationException(
                        "Superior Bot could not acquire the machine-wide single-instance lock for "
                            + target.Key
                            + ". Another Windows account or service may already be using it. "
                            + "Stop that process or correct the lock permissions before retrying.",
                        error
                    );
                }
                bool ownsMutex = false;
                try
                {
                    ownsMutex = mutex.WaitOne(0, false);
                }
                catch (AbandonedMutexException)
                {
                    ownsMutex = true;
                    LauncherSupport.Log(
                        "WARN",
                        "Recovered a stale single-instance lock for " + target.Key + "."
                    );
                }
                if (!ownsMutex)
                {
                    mutex.Dispose();
                    throw new InvalidOperationException(
                        "Another Superior Bot instance is already using this "
                            + target.Key
                            + ": "
                            + target.Value
                            + ". Stop the old process before starting or replacing SuperiorBot.exe."
                    );
                }
                acquired.Add(mutex);
            }
            return new SuperiorInstanceGuard(acquired);
        }
        catch
        {
            ReleaseAll(acquired);
            throw;
        }
    }

    public static string BuildMutexName(string scope, string target)
    {
        string canonical = scope + "\0" + Path.GetFullPath(target).ToUpperInvariant();
        byte[] bytes = Encoding.UTF8.GetBytes(canonical);
        using (SHA256 sha256 = SHA256.Create())
        {
            string hash = BitConverter.ToString(sha256.ComputeHash(bytes)).Replace("-", "");
            return @"Global\SuperiorBot-" + hash;
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        ReleaseAll(mutexes);
    }

    private static void ReleaseAll(List<Mutex> mutexes)
    {
        for (int index = mutexes.Count - 1; index >= 0; index -= 1)
        {
            try
            {
                mutexes[index].ReleaseMutex();
            }
            finally
            {
                mutexes[index].Dispose();
            }
        }
        mutexes.Clear();
    }
}
