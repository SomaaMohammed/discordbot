using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class Program
{
    private const string ProductName = "SuperiorBot.exe";
    private const int CommandTimeoutMilliseconds = 120000;

    private static int Main(string[] args)
    {
        try
        {
            Options options = ParseOptions(args);
            if (options.Help)
            {
                PrintHelp();
                return 0;
            }
            if (options.Version)
            {
                Console.WriteLine("Superior Bot updater " + BuildIdentity.Version);
                return 0;
            }

            string updaterRoot = NormalizeDirectory(AppDomain.CurrentDomain.BaseDirectory);
            string targetRoot = NormalizeDirectory(options.TargetRoot ?? updaterRoot);
            RefuseReparsePoint(targetRoot, "The update target directory");
            if (!Directory.Exists(targetRoot))
            {
                throw new InvalidDataException("The update target directory does not exist: " + targetRoot);
            }

            string source = Path.GetFullPath(options.Source);
            string target = Path.Combine(targetRoot, ProductName);
            RefuseReparsePoint(source, "The update source executable");
            if (!File.Exists(source))
            {
                throw new FileNotFoundException("The update source executable was not found.", source);
            }
            if (string.Equals(source, target, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "The update source is already the installed executable. Supply a newly built SuperiorBot.exe."
                );
            }

            EnsureTargetStopped(target);
            string sourceVersion = VerifyExecutable(source, options.ExpectedSha256);
            string currentVersion = File.Exists(target) ? ReadVersion(target) : null;
            if (
                currentVersion != null &&
                !options.AllowDowngrade &&
                CompareVersions(sourceVersion, currentVersion) <= 0
            )
            {
                throw new InvalidOperationException(
                    "The source version "
                        + sourceVersion
                        + " is not newer than the installed version "
                        + currentVersion
                        + ". Use --allow-downgrade only for an intentional rollback."
                );
            }

            string environmentFile = Path.Combine(targetRoot, ".env");
            if (!File.Exists(environmentFile))
            {
                throw new InvalidOperationException(
                    "The target folder has no .env file. Copy the existing .env beside SuperiorBot.exe before updating."
                );
            }

            string stagingRoot = Path.Combine(
                targetRoot,
                ".update-" + Guid.NewGuid().ToString("N")
            );
            Directory.CreateDirectory(stagingRoot);
            RefuseReparsePoint(stagingRoot, "The update staging directory");
            string stagedExecutable = Path.Combine(stagingRoot, ProductName);
            string backupRoot = Path.Combine(targetRoot, "backups");
            Directory.CreateDirectory(backupRoot);
            RefuseReparsePoint(backupRoot, "The executable backup directory");
            string backup = Path.Combine(
                backupRoot,
                ProductName + "." + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + ".bak"
            );

            bool targetExisted = File.Exists(target);
            try
            {
                File.Copy(source, stagedExecutable, false);
                RefuseReparsePoint(stagedExecutable, "The staged update executable");
                if (targetExisted)
                {
                    File.Copy(target, backup, false);
                    ReplaceFile(stagedExecutable, target);
                }
                else
                {
                    File.Move(stagedExecutable, target);
                }

                string installedVersion = ReadVersion(target);
                if (!string.Equals(installedVersion, sourceVersion, StringComparison.Ordinal))
                {
                    throw new InvalidDataException(
                        "The installed executable reported "
                            + installedVersion
                            + " instead of "
                            + sourceVersion
                            + "."
                    );
                }
                int checkExitCode = RunCommand(target, "--check", CommandTimeoutMilliseconds);
                if (checkExitCode != 0)
                {
                    throw new InvalidDataException(
                        "The updated executable failed its configuration check with exit code "
                            + checkExitCode
                            + "."
                    );
                }

                Console.WriteLine(
                    "Updated SuperiorBot.exe to "
                        + sourceVersion
                        + ". .env, database, and backups were preserved."
                );
                if (!options.NoStart)
                {
                    StartBot(target, targetRoot);
                    Console.WriteLine("SuperiorBot.exe started.");
                }
                return 0;
            }
            catch
            {
                if (File.Exists(backup))
                {
                    try
                    {
                        string restoreRoot = Path.Combine(
                            targetRoot,
                            ".update-restore-" + Guid.NewGuid().ToString("N")
                        );
                        Directory.CreateDirectory(restoreRoot);
                        string restore = Path.Combine(restoreRoot, ProductName);
                        File.Copy(backup, restore, false);
                        ReplaceFile(restore, target);
                        TryDeleteDirectory(restoreRoot, targetRoot);
                        Console.Error.WriteLine("The previous executable was restored from " + backup + ".");
                    }
                    catch (Exception restoreError)
                    {
                        Console.Error.WriteLine(
                            "Automatic rollback failed: " + SafeMessage(restoreError.Message)
                        );
                    }
                }
                else if (!targetExisted && File.Exists(target))
                {
                    try
                    {
                        File.Delete(target);
                    }
                    catch (Exception removeError)
                    {
                        Console.Error.WriteLine(
                            "The failed first installation could not be removed: "
                                + SafeMessage(removeError.Message)
                        );
                    }
                }
                throw;
            }
            finally
            {
                TryDeleteDirectory(stagingRoot, targetRoot);
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Superior Bot updater failed: " + SafeMessage(error.Message));
            return 1;
        }
    }

    private static Options ParseOptions(string[] args)
    {
        Options options = new Options();
        for (int index = 0; index < args.Length; index += 1)
        {
            string argument = args[index];
            if (EqualsOption(argument, "--help"))
            {
                options.Help = true;
            }
            else if (EqualsOption(argument, "--version"))
            {
                options.Version = true;
            }
            else if (EqualsOption(argument, "--no-start"))
            {
                options.NoStart = true;
            }
            else if (EqualsOption(argument, "--allow-downgrade"))
            {
                options.AllowDowngrade = true;
            }
            else if (EqualsOption(argument, "--source"))
            {
                options.Source = RequireValue(args, ref index, "--source");
            }
            else if (EqualsOption(argument, "--target"))
            {
                options.TargetRoot = RequireValue(args, ref index, "--target");
            }
            else if (EqualsOption(argument, "--sha256"))
            {
                options.ExpectedSha256 = RequireValue(args, ref index, "--sha256");
            }
            else
            {
                throw new ArgumentException("Unknown option: " + argument + ". Use --help for usage.");
            }
        }

        if (options.Help || options.Version)
        {
            if (args.Length != 1)
            {
                throw new ArgumentException("--help and --version must be used alone.");
            }
            return options;
        }
        if (string.IsNullOrWhiteSpace(options.Source))
        {
            throw new ArgumentException("--source is required. Use --help for usage.");
        }
        options.Source = Path.GetFullPath(options.Source);
        if (!string.IsNullOrWhiteSpace(options.TargetRoot))
        {
            options.TargetRoot = Path.GetFullPath(options.TargetRoot);
        }
        return options;
    }

    private static string VerifyExecutable(string executable, string expectedSha256)
    {
        if (!string.IsNullOrWhiteSpace(expectedSha256))
        {
            string expected = expectedSha256.Trim().ToLowerInvariant();
            if (!IsSha256(expected))
            {
                throw new ArgumentException("--sha256 must be a 64-character lowercase hexadecimal hash.");
            }
            string actual = ComputeSha256(executable);
            if (!string.Equals(actual, expected, StringComparison.Ordinal))
            {
                throw new InvalidDataException(
                    "The source executable SHA-256 does not match --sha256."
                );
            }
        }
        string version = ReadVersion(executable);
        Console.WriteLine("Verified source SuperiorBot.exe version " + version + ".");
        return version;
    }

    private static string ReadVersion(string executable)
    {
        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = "--version",
            WorkingDirectory = Path.GetDirectoryName(executable) ?? Environment.CurrentDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using (Process process = Process.Start(start) ?? throw new InvalidOperationException("Unable to start the executable for version verification."))
        {
            if (!process.WaitForExit(CommandTimeoutMilliseconds))
            {
                TryKill(process);
                throw new InvalidDataException("The executable did not report its version before the timeout.");
            }
            string output = process.StandardOutput.ReadToEnd().Trim();
            string error = process.StandardError.ReadToEnd().Trim();
            if (process.ExitCode != 0)
            {
                throw new InvalidDataException(
                    "The executable failed version verification: " + SafeMessage(error.Length > 0 ? error : output)
                );
            }
            const string prefix = "Superior Bot ";
            string line = null;
            foreach (string candidate in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (candidate.StartsWith(prefix, StringComparison.Ordinal))
                {
                    line = candidate.Substring(prefix.Length).Trim();
                    break;
                }
            }
            Version parsed;
            if (line == null || !Version.TryParse(line, out parsed) || parsed.Build < 0)
            {
                throw new InvalidDataException("The executable returned an invalid Superior Bot version.");
            }
            return parsed.ToString(3);
        }
    }

    private static int RunCommand(string executable, string arguments, int timeoutMilliseconds)
    {
        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = arguments,
            WorkingDirectory = Path.GetDirectoryName(executable) ?? Environment.CurrentDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using (Process process = Process.Start(start) ?? throw new InvalidOperationException("Unable to start the updated executable."))
        {
            if (!process.WaitForExit(timeoutMilliseconds))
            {
                TryKill(process);
                throw new InvalidDataException("The updated executable did not finish its configuration check before the timeout.");
            }
            string output = process.StandardOutput.ReadToEnd().Trim();
            string error = process.StandardError.ReadToEnd().Trim();
            if (process.ExitCode != 0 && error.Length > 0)
            {
                Console.Error.WriteLine("Configuration check output: " + SafeMessage(error));
            }
            else if (output.Length > 0)
            {
                Console.WriteLine(output);
            }
            return process.ExitCode;
        }
    }

    private static void StartBot(string executable, string workingDirectory)
    {
        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = workingDirectory,
            UseShellExecute = true,
            CreateNoWindow = false
        };
        if (Process.Start(start) == null)
        {
            throw new InvalidOperationException("The updated executable could not be started.");
        }
    }

    private static void EnsureTargetStopped(string target)
    {
        string normalizedTarget = Path.GetFullPath(target);
        foreach (Process process in Process.GetProcessesByName("SuperiorBot"))
        {
            try
            {
                string processPath = process.MainModule == null ? null : process.MainModule.FileName;
                if (
                    processPath != null &&
                    string.Equals(Path.GetFullPath(processPath), normalizedTarget, StringComparison.OrdinalIgnoreCase)
                )
                {
                    throw new InvalidOperationException(
                        "The installed SuperiorBot.exe is still running. Close it before starting the updater."
                    );
                }
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch
            {
                // An unrelated process or a process that exited during inspection is ignored.
            }
            finally
            {
                process.Dispose();
            }
        }
    }

    private static void ReplaceFile(string replacement, string target)
    {
        if (!File.Exists(target))
        {
            File.Move(replacement, target);
            return;
        }
        File.Replace(replacement, target, null, true);
    }

    private static int CompareVersions(string left, string right)
    {
        return new Version(left).CompareTo(new Version(right));
    }

    private static string ComputeSha256(string fileName)
    {
        using (SHA256 sha256 = SHA256.Create())
        using (FileStream stream = File.OpenRead(fileName))
        {
            byte[] hash = sha256.ComputeHash(stream);
            return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
        }
    }

    private static bool IsSha256(string value)
    {
        if (value.Length != 64) return false;
        foreach (char character in value)
        {
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
            {
                return false;
            }
        }
        return true;
    }

    private static string RequireValue(string[] args, ref int index, string option)
    {
        index += 1;
        if (index >= args.Length || string.IsNullOrWhiteSpace(args[index]))
        {
            throw new ArgumentException(option + " requires a value.");
        }
        return args[index];
    }

    private static bool EqualsOption(string value, string expected)
    {
        return string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeDirectory(string path)
    {
        return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static void RefuseReparsePoint(string path, string description)
    {
        if (File.Exists(path) || Directory.Exists(path))
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException(description + " must not be a reparse point.");
            }
        }
    }

    private static void TryDeleteDirectory(string directory, string expectedParent)
    {
        try
        {
            string resolved = Path.GetFullPath(directory);
            string expected = Path.GetFullPath(expectedParent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!resolved.StartsWith(expected, StringComparison.OrdinalIgnoreCase)) return;
            if (!Path.GetFileName(resolved).StartsWith(".update-", StringComparison.Ordinal)) return;
            if (Directory.Exists(resolved)) Directory.Delete(resolved, true);
        }
        catch
        {
            // A failed cleanup does not invalidate a verified update.
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill();
            process.WaitForExit(5000);
        }
        catch
        {
            // The timeout error remains the useful failure.
        }
    }

    private static string SafeMessage(string value)
    {
        StringBuilder result = new StringBuilder(Math.Min(value.Length, 2048));
        foreach (char character in value)
        {
            if (result.Length >= 2048) break;
            result.Append(char.IsControl(character) ? ' ' : character);
        }
        return result.ToString();
    }

    private static void PrintHelp()
    {
        Console.WriteLine("Update.exe --source <new SuperiorBot.exe> [--target <bot folder>] [--sha256 <hash>] [--no-start]");
        Console.WriteLine("Updates the installed executable while preserving .env, the database, and backups.");
        Console.WriteLine("The installed bot must be stopped first. --allow-downgrade is available for intentional rollback.");
    }

    private sealed class Options
    {
        public bool Help;
        public bool Version;
        public bool NoStart;
        public bool AllowDowngrade;
        public string Source = "";
        public string TargetRoot;
        public string ExpectedSha256;
    }
}
