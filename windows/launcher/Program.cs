using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && LauncherSupport.EqualsOption(args[0], "--help"))
            {
                Console.WriteLine("SuperiorBot.exe [--check | --diagnostics | --doctor [--json] [--write-probes] | --checkpoint [--mode MODE] [--json] | --backup-rotate [--retention COUNT] [--dry-run] [--json] | --version | --help]");
                Console.WriteLine("Run without an option to start the Discord bot.");
                return 0;
            }

            bool showVersion = args.Length == 1 && LauncherSupport.EqualsOption(args[0], "--version");
            bool checkOnly = args.Length == 1 && LauncherSupport.EqualsOption(args[0], "--check");
            bool diagnosticsOnly =
                args.Length == 1 && LauncherSupport.EqualsOption(args[0], "--diagnostics");
            bool doctorCommand = IsDoctorCommand(args);
            bool checkpointCommand = IsCheckpointCommand(args);
            bool backupRotationCommand = IsBackupRotationCommand(args);
            bool offlineSmoke =
                Environment.GetEnvironmentVariable("SUPERIOR_TEST_MODE") == "1"
                && args.Length == 1
                && LauncherSupport.EqualsOption(args[0], "--offline-smoke");
            if (
                args.Length != 0
                && !showVersion
                && !checkOnly
                && !diagnosticsOnly
                && !doctorCommand
                && !checkpointCommand
                && !backupRotationCommand
                && !offlineSmoke
            )
            {
                Console.Error.WriteLine("Unknown option. Use --help for supported options.");
                return 2;
            }

            string root = LauncherSupport.NormalizeRoot(AppDomain.CurrentDomain.BaseDirectory);
            LauncherSupport.ValidatePortableManifest(root);
            string version = LauncherSupport.VerifyPayloadVersion(root);
            string sourceIdentity = LauncherSupport.ReadSourceIdentity(root);
            LauncherSupport.VerifyReleaseSignatures(
                root,
                Assembly.GetExecutingAssembly().Location
            );
            string manifest = Path.Combine(root, "MANIFEST.sha256");
            if (!File.Exists(manifest))
            {
                throw new InvalidDataException("The application payload manifest is missing.");
            }
            string payloadHash = LauncherSupport.ComputeSha256(manifest);

            if (showVersion)
            {
                Console.WriteLine("Superior Bot " + version);
                return 0;
            }

            string environmentFile = LauncherSupport.ResolveEnvironmentFile(root);
            if (diagnosticsOnly)
            {
                using (SuperiorInstanceGuard instance =
                    LauncherSupport.AcquireInstanceGuard(root, environmentFile))
                {
                    return RunBun(
                        root,
                        environmentFile,
                        new string[] { "--diagnostics" },
                        version,
                        payloadHash,
                        sourceIdentity,
                        "portable-directory",
                        true,
                        false,
                        instance.DatabaseFile
                    );
                }
            }

            if (doctorCommand)
            {
                using (SuperiorInstanceGuard instance =
                    LauncherSupport.AcquireInstanceGuard(root, environmentFile))
                {
                    return RunBun(
                        root,
                        environmentFile,
                        args,
                        version,
                        payloadHash,
                        sourceIdentity,
                        "portable-directory",
                        false,
                        false,
                        instance.DatabaseFile
                    );
                }
            }

            if (!File.Exists(environmentFile))
            {
                Console.Error.WriteLine(
                    "Missing environment file for SuperiorBot.exe. Copy .env.example to .env and add your Discord token."
                );
                return 2;
            }

            if (checkOnly)
            {
                return RunBun(
                    root,
                    environmentFile,
                    new string[] { "--check" },
                    version,
                    payloadHash,
                    sourceIdentity,
                    "portable-directory",
                    false,
                    false,
                    null
                );
            }

            using (SuperiorInstanceGuard instance =
                LauncherSupport.AcquireInstanceGuard(root, environmentFile))
            {
                if (checkpointCommand || backupRotationCommand)
                {
                    return RunBun(
                        root,
                        environmentFile,
                        args,
                        version,
                        payloadHash,
                        sourceIdentity,
                        "portable-directory",
                        false,
                        false,
                        instance.DatabaseFile
                    );
                }
                LauncherSupport.Log("INFO", "Superior Bot " + version + " starting.");
                LauncherSupport.Log(
                    "INFO",
                    "executablePath=" + Assembly.GetExecutingAssembly().Location
                );
                LauncherSupport.Log("INFO", "applicationRoot=" + root);
                LauncherSupport.Log(
                    "INFO",
                    "payloadVersion=" + version + " payloadSha256=" + payloadHash + " cache=portable-directory"
                );
                int exitCode = RunBun(
                    root,
                    environmentFile,
                    offlineSmoke
                        ? new string[] { "--offline-smoke" }
                        : new string[0],
                    version,
                    payloadHash,
                    sourceIdentity,
                    "portable-directory",
                    false,
                    true,
                    instance.DatabaseFile
                );
                LauncherSupport.Log(
                    exitCode == 0 ? "INFO" : "ERROR",
                    "Bundled Bun process exited. exitCode=" + exitCode
                );
                return exitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Superior Bot launcher failed: " + LauncherSupport.SafeField(error.Message, 2048));
            return 1;
        }
    }

    private static int RunBun(
        string root,
        string environmentFile,
        string[] runtimeArguments,
        string version,
        string payloadHash,
        string sourceIdentity,
        string cacheStatus,
        bool diagnostics,
        bool autoMigrate,
        string databaseLockFile
    )
    {
        string runtime = Path.Combine(root, "app", "SuperiorBot.Runtime.exe");
        if (!File.Exists(runtime))
        {
            Console.Error.WriteLine("The compiled Bun application runtime is missing.");
            return 1;
        }

        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = runtime,
            Arguments = BuildArguments(runtimeArguments),
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = false
        };
        LauncherSupport.SanitizeBunRuntimeEnvironment(start);
        start.EnvironmentVariables["ENV_FILE"] = environmentFile;
        start.EnvironmentVariables["SUPERIOR_APPLICATION_ROOT"] = root;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_ROOT"] = root;
        start.EnvironmentVariables["SUPERIOR_EXECUTABLE_VERSION"] = version;
        start.EnvironmentVariables["SUPERIOR_EXECUTABLE_PATH"] = Assembly.GetExecutingAssembly().Location;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_VERSION"] = version;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_SHA256"] = payloadHash;
        start.EnvironmentVariables["SUPERIOR_SOURCE_SHA256"] = sourceIdentity;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_CACHE"] = cacheStatus;
        if (autoMigrate)
        {
            start.EnvironmentVariables["SUPERIOR_AUTO_MIGRATE"] = "1";
        }
        if (databaseLockFile != null)
        {
            start.EnvironmentVariables["DB_FILE"] = databaseLockFile;
            start.EnvironmentVariables["SUPERIOR_DATABASE_LOCK_HELD"] = "1";
            start.EnvironmentVariables["SUPERIOR_DATABASE_LOCK_PATH"] = databaseLockFile;
        }
        if (!diagnostics)
        {
            start.EnvironmentVariables["SUPERIOR_PORTABLE_EXPECT_ROOT"] = root;
            start.EnvironmentVariables["SUPERIOR_PORTABLE_EXPECT_ENV"] = environmentFile;
            if (databaseLockFile != null)
            {
                start.EnvironmentVariables["SUPERIOR_PORTABLE_EXPECT_DB"] = databaseLockFile;
            }
        }

        return LauncherSupport.RunChild(start);
    }

    private static string BuildArguments(string[] arguments)
    {
        string result = "";
        foreach (string argument in arguments)
        {
            if (result.Length > 0)
            {
                result += " ";
            }
            result += LauncherSupport.QuoteArgument(argument);
        }
        return result;
    }

    private static bool IsDoctorCommand(string[] args)
    {
        if (args.Length < 1 || !LauncherSupport.EqualsOption(args[0], "--doctor"))
        {
            return false;
        }
        bool json = false;
        bool writeProbes = false;
        for (int index = 1; index < args.Length; index += 1)
        {
            if (LauncherSupport.EqualsOption(args[index], "--json") && !json)
            {
                json = true;
                continue;
            }
            if (LauncherSupport.EqualsOption(args[index], "--write-probes") && !writeProbes)
            {
                writeProbes = true;
                continue;
            }
            return false;
        }
        return true;
    }

    private static bool IsCheckpointCommand(string[] args)
    {
        if (args.Length < 1 || !LauncherSupport.EqualsOption(args[0], "--checkpoint"))
        {
            return false;
        }
        bool json = false;
        bool mode = false;
        for (int index = 1; index < args.Length; index += 1)
        {
            if (LauncherSupport.EqualsOption(args[index], "--json") && !json)
            {
                json = true;
                continue;
            }
            if (
                LauncherSupport.EqualsOption(args[index], "--mode")
                && !mode
                && index + 1 < args.Length
                && IsCheckpointMode(args[index + 1])
            )
            {
                mode = true;
                index += 1;
                continue;
            }
            return false;
        }
        return true;
    }

    private static bool IsCheckpointMode(string value)
    {
        return LauncherSupport.EqualsOption(value, "passive")
            || LauncherSupport.EqualsOption(value, "full")
            || LauncherSupport.EqualsOption(value, "restart")
            || LauncherSupport.EqualsOption(value, "truncate");
    }

    private static bool IsBackupRotationCommand(string[] args)
    {
        if (args.Length < 1 || !LauncherSupport.EqualsOption(args[0], "--backup-rotate"))
        {
            return false;
        }
        bool json = false;
        bool dryRun = false;
        bool retention = false;
        for (int index = 1; index < args.Length; index += 1)
        {
            if (LauncherSupport.EqualsOption(args[index], "--json") && !json)
            {
                json = true;
                continue;
            }
            if (LauncherSupport.EqualsOption(args[index], "--dry-run") && !dryRun)
            {
                dryRun = true;
                continue;
            }
            int parsedRetention;
            if (
                LauncherSupport.EqualsOption(args[index], "--retention")
                && !retention
                && index + 1 < args.Length
                && Int32.TryParse(args[index + 1], out parsedRetention)
                && parsedRetention >= 1
                && parsedRetention <= 1000
            )
            {
                retention = true;
                index += 1;
                continue;
            }
            return false;
        }
        return true;
    }
}
