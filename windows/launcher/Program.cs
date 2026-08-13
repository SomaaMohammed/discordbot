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
                Console.WriteLine("SuperiorBot.exe [--check | --diagnostics | --version | --help]");
                Console.WriteLine("Run without an option to start the Discord bot.");
                return 0;
            }

            bool showVersion = args.Length == 1 && LauncherSupport.EqualsOption(args[0], "--version");
            bool checkOnly = args.Length == 1 && LauncherSupport.EqualsOption(args[0], "--check");
            bool diagnosticsOnly =
                args.Length == 1 && LauncherSupport.EqualsOption(args[0], "--diagnostics");
            if (args.Length != 0 && !showVersion && !checkOnly && !diagnosticsOnly)
            {
                Console.Error.WriteLine("Unknown option. Use --help for supported options.");
                return 2;
            }

            string root = LauncherSupport.NormalizeRoot(AppDomain.CurrentDomain.BaseDirectory);
            LauncherSupport.ValidatePortableManifest(root);
            string version = LauncherSupport.VerifyPayloadVersion(root);
            string sourceIdentity = LauncherSupport.ReadSourceIdentity(root);
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
                return RunNode(
                    root,
                    environmentFile,
                    Path.Combine(root, "tools", "diagnostics.mjs"),
                    version,
                    payloadHash,
                    sourceIdentity,
                    "portable-directory",
                    true
                );
            }

            if (!File.Exists(environmentFile))
            {
                Console.Error.WriteLine(
                    "Missing environment file for SuperiorBot.exe. Copy .env.example to .env and add your Discord token."
                );
                return 2;
            }

            string script = checkOnly
                ? Path.Combine(root, "tools", "check-portable.mjs")
                : Path.Combine(root, "app", "dist", "src", "index.js");
            if (checkOnly)
            {
                return RunNode(
                    root,
                    environmentFile,
                    script,
                    version,
                    payloadHash,
                    sourceIdentity,
                    "portable-directory",
                    false
                );
            }

            using (SuperiorInstanceGuard instance =
                LauncherSupport.AcquireInstanceGuard(root, environmentFile))
            {
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
                int exitCode = RunNode(
                    root,
                    environmentFile,
                    script,
                    version,
                    payloadHash,
                    sourceIdentity,
                    "portable-directory",
                    false
                );
                LauncherSupport.Log(
                    exitCode == 0 ? "INFO" : "ERROR",
                    "Bundled Node process exited. exitCode=" + exitCode
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

    private static int RunNode(
        string root,
        string environmentFile,
        string script,
        string version,
        string payloadHash,
        string sourceIdentity,
        string cacheStatus,
        bool diagnostics
    )
    {
        string node = Path.Combine(root, "runtime", "node.exe");
        if (!File.Exists(node))
        {
            Console.Error.WriteLine("The bundled Windows Node runtime is missing.");
            return 1;
        }
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("The packaged application entrypoint is missing.");
            return 1;
        }

        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = node,
            Arguments = LauncherSupport.QuoteArgument(script),
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = false
        };
        start.EnvironmentVariables["ENV_FILE"] = environmentFile;
        start.EnvironmentVariables["SUPERIOR_APPLICATION_ROOT"] = root;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_ROOT"] = root;
        start.EnvironmentVariables["SUPERIOR_EXECUTABLE_VERSION"] = version;
        start.EnvironmentVariables["SUPERIOR_EXECUTABLE_PATH"] = Assembly.GetExecutingAssembly().Location;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_VERSION"] = version;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_SHA256"] = payloadHash;
        start.EnvironmentVariables["SUPERIOR_SOURCE_SHA256"] = sourceIdentity;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_CACHE"] = cacheStatus;
        if (!diagnostics)
        {
            start.EnvironmentVariables["SUPERIOR_PORTABLE_EXPECT_ROOT"] = root;
            start.EnvironmentVariables["SUPERIOR_PORTABLE_EXPECT_ENV"] = environmentFile;
        }

        return LauncherSupport.RunChild(start);
    }
}
