using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

internal static class Program
{
    private const string PayloadResourceName = "SuperiorBot.Payload.zip";

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

            string applicationRoot = LauncherSupport.NormalizeRoot(AppDomain.CurrentDomain.BaseDirectory);
            PayloadLocation payload = EnsurePayload();
            string version = LauncherSupport.VerifyPayloadVersion(payload.Root);
            string sourceIdentity = LauncherSupport.ReadSourceIdentity(payload.Root);

            if (showVersion)
            {
                Console.WriteLine("Superior Bot " + version);
                return 0;
            }

            string environmentFile = LauncherSupport.ResolveEnvironmentFile(applicationRoot);
            if (diagnosticsOnly)
            {
                return RunNode(
                    applicationRoot,
                    payload,
                    environmentFile,
                    Path.Combine(payload.Root, "tools", "diagnostics.mjs"),
                    version,
                    sourceIdentity,
                    true,
                    false
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
                ? Path.Combine(payload.Root, "tools", "check-portable.mjs")
                : Path.Combine(payload.Root, "app", "dist", "src", "index.js");
            if (checkOnly)
            {
                return RunNode(
                    applicationRoot,
                    payload,
                    environmentFile,
                    script,
                    version,
                    sourceIdentity,
                    false,
                    false
                );
            }

            using (SuperiorInstanceGuard instance =
                LauncherSupport.AcquireInstanceGuard(applicationRoot, environmentFile))
            {
                LauncherSupport.Log("INFO", "Superior Bot " + version + " starting.");
                LauncherSupport.Log(
                    "INFO",
                    "executablePath=" + Assembly.GetExecutingAssembly().Location
                );
                LauncherSupport.Log("INFO", "applicationRoot=" + applicationRoot);
                LauncherSupport.Log(
                    "INFO",
                    "payloadVersion="
                        + version
                        + " payloadSha256="
                        + payload.Sha256
                        + " cache="
                        + payload.CacheStatus
                );
                int exitCode = RunNode(
                    applicationRoot,
                    payload,
                    environmentFile,
                    script,
                    version,
                    sourceIdentity,
                    false,
                    true
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
        string applicationRoot,
        PayloadLocation payload,
        string environmentFile,
        string script,
        string version,
        string sourceIdentity,
        bool diagnostics,
        bool autoMigrate
    )
    {
        string node = Path.Combine(payload.Root, "runtime", "node.exe");
        if (!File.Exists(node))
        {
            Console.Error.WriteLine("The embedded Windows Node runtime is missing.");
            return 1;
        }
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("The embedded application entrypoint is missing.");
            return 1;
        }

        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = node,
            Arguments = LauncherSupport.QuoteArgument(script),
            WorkingDirectory = applicationRoot,
            UseShellExecute = false,
            CreateNoWindow = false
        };
        start.EnvironmentVariables["ENV_FILE"] = environmentFile;
        start.EnvironmentVariables["SUPERIOR_APPLICATION_ROOT"] = applicationRoot;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_ROOT"] = payload.Root;
        start.EnvironmentVariables["SUPERIOR_EXECUTABLE_VERSION"] = version;
        start.EnvironmentVariables["SUPERIOR_EXECUTABLE_PATH"] = Assembly.GetExecutingAssembly().Location;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_VERSION"] = version;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_SHA256"] = payload.Sha256;
        start.EnvironmentVariables["SUPERIOR_SOURCE_SHA256"] = sourceIdentity;
        start.EnvironmentVariables["SUPERIOR_PAYLOAD_CACHE"] = payload.CacheStatus;
        if (autoMigrate)
        {
            start.EnvironmentVariables["SUPERIOR_AUTO_MIGRATE"] = "1";
        }
        if (!diagnostics)
        {
            start.EnvironmentVariables["SUPERIOR_PORTABLE_EXPECT_ROOT"] = applicationRoot;
            start.EnvironmentVariables["SUPERIOR_PORTABLE_EXPECT_ENV"] = environmentFile;
        }

        return LauncherSupport.RunChild(start);
    }

    private static PayloadLocation EnsurePayload()
    {
        string localApplicationData = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData
        );
        if (string.IsNullOrWhiteSpace(localApplicationData))
        {
            throw new InvalidOperationException("Windows did not provide a local application-data folder.");
        }

        string productRoot = Path.Combine(localApplicationData, "SuperiorBot");
        string cacheRoot = Path.Combine(productRoot, "payloads");
        if (!Directory.Exists(productRoot))
        {
            Directory.CreateDirectory(productRoot);
        }
        LauncherSupport.RefuseReparsePoint(productRoot, "The Superior Bot cache root");
        if (!Directory.Exists(cacheRoot))
        {
            Directory.CreateDirectory(cacheRoot);
        }
        LauncherSupport.RefuseReparsePoint(cacheRoot, "The Superior Bot payload cache");
        string incomingRoot = Path.Combine(cacheRoot, ".incoming-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(incomingRoot);
        LauncherSupport.RefuseReparsePoint(incomingRoot, "The incoming payload directory");

        try
        {
            string archivePath = Path.Combine(incomingRoot, "payload.zip");
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResourceName))
            {
                if (payload == null)
                {
                    throw new InvalidOperationException("The embedded application payload is missing.");
                }
                using (FileStream archive = new FileStream(
                    archivePath,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None
                ))
                {
                    payload.CopyTo(archive);
                }
            }

            string payloadHash = LauncherSupport.ComputeSha256(archivePath);
            string installedRoot = Path.Combine(cacheRoot, payloadHash);
            if (IsReadyPayload(installedRoot, payloadHash))
            {
                return new PayloadLocation(
                    FindPortableRoot(installedRoot),
                    payloadHash,
                    "reused"
                );
            }
            if (Directory.Exists(installedRoot))
            {
                throw new InvalidOperationException(
                    "The private runtime cache is incomplete. Remove " + installedRoot + " and try again."
                );
            }

            string contentRoot = Path.Combine(incomingRoot, "content");
            Directory.CreateDirectory(contentRoot);
            ExtractArchiveSafely(archivePath, contentRoot);
            LauncherSupport.ValidateTreeHasNoReparsePoints(contentRoot);
            string portableRoot = FindPortableRoot(contentRoot);
            ValidatePortableRoot(portableRoot);
            File.WriteAllText(Path.Combine(contentRoot, ".ready"), payloadHash);

            string cacheStatus = "created";
            try
            {
                Directory.Move(contentRoot, installedRoot);
            }
            catch (IOException)
            {
                if (!IsReadyPayload(installedRoot, payloadHash))
                {
                    throw;
                }
                cacheStatus = "reused-after-concurrent-extraction";
            }

            LauncherSupport.ValidateTreeHasNoReparsePoints(installedRoot);
            return new PayloadLocation(
                FindPortableRoot(installedRoot),
                payloadHash,
                cacheStatus
            );
        }
        finally
        {
            TryDeleteDirectory(incomingRoot, cacheRoot);
        }
    }

    private static void ExtractArchiveSafely(string archivePath, string destinationRoot)
    {
        string destinationPrefix = Path.GetFullPath(destinationRoot).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        ) + Path.DirectorySeparatorChar;

        using (ZipArchive archive = ZipFile.OpenRead(archivePath))
        {
            long totalUncompressedBytes = 0;
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                if (entry.Length < 0 || entry.Length > 268435456)
                {
                    throw new InvalidDataException("The embedded payload contains an oversized entry.");
                }
                checked
                {
                    totalUncompressedBytes += entry.Length;
                }
                if (totalUncompressedBytes > 1073741824)
                {
                    throw new InvalidDataException("The embedded payload exceeds its extraction limit.");
                }
                int unixMode = (entry.ExternalAttributes >> 16) & 0xF000;
                if (unixMode == 0xA000)
                {
                    throw new InvalidDataException("The embedded payload contains a symbolic link.");
                }
                string relativeName = entry.FullName
                    .Replace('/', Path.DirectorySeparatorChar)
                    .Replace('\\', Path.DirectorySeparatorChar);
                string destination = Path.GetFullPath(Path.Combine(destinationRoot, relativeName));
                if (!destination.StartsWith(destinationPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("The embedded payload contains an unsafe path.");
                }

                if (string.IsNullOrEmpty(entry.Name))
                {
                    Directory.CreateDirectory(destination);
                    LauncherSupport.RefuseReparsePoint(destination, "An extracted payload directory");
                    continue;
                }

                string parent = Path.GetDirectoryName(destination);
                if (!string.IsNullOrEmpty(parent))
                {
                    Directory.CreateDirectory(parent);
                    LauncherSupport.RefuseReparsePoint(parent, "An extracted payload directory");
                }
                entry.ExtractToFile(destination, false);
                LauncherSupport.RefuseReparsePoint(destination, "An extracted payload file");
            }
        }
    }

    private static bool IsReadyPayload(string installedRoot, string expectedHash)
    {
        if (!Directory.Exists(installedRoot))
        {
            return false;
        }
        LauncherSupport.ValidateTreeHasNoReparsePoints(installedRoot);
        string marker = Path.Combine(installedRoot, ".ready");
        if (!File.Exists(marker) || File.ReadAllText(marker).Trim() != expectedHash)
        {
            return false;
        }
        try
        {
            ValidatePortableRoot(FindPortableRoot(installedRoot));
            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    private static string FindPortableRoot(string extractedRoot)
    {
        string[] directories = Directory.GetDirectories(extractedRoot);
        if (directories.Length != 1)
        {
            throw new InvalidDataException("The embedded payload has an unexpected directory layout.");
        }
        return directories[0];
    }

    private static void ValidatePortableRoot(string portableRoot)
    {
        string[] requiredFiles =
        {
            Path.Combine(portableRoot, "BUILD-INFO.txt"),
            Path.Combine(portableRoot, "MANIFEST.sha256"),
            Path.Combine(portableRoot, "VERSION"),
            Path.Combine(portableRoot, "runtime", "node.exe"),
            Path.Combine(portableRoot, "tools", "check-portable.mjs"),
            Path.Combine(portableRoot, "tools", "diagnostics.mjs"),
            Path.Combine(portableRoot, "app", "dist", "src", "index.js")
        };
        foreach (string requiredFile in requiredFiles)
        {
            if (!File.Exists(requiredFile))
            {
                throw new InvalidDataException("The embedded payload is incomplete.");
            }
        }
        LauncherSupport.ValidatePortableManifest(portableRoot);
        LauncherSupport.VerifyPayloadVersion(portableRoot);
        LauncherSupport.ReadSourceIdentity(portableRoot);
    }

    private static void TryDeleteDirectory(string directory, string expectedParent)
    {
        try
        {
            string resolved = Path.GetFullPath(directory);
            string parent = Path.GetDirectoryName(resolved);
            if (
                !string.Equals(
                    parent,
                    Path.GetFullPath(expectedParent),
                    StringComparison.OrdinalIgnoreCase
                )
                || !Path.GetFileName(resolved).StartsWith(
                    ".incoming-",
                    StringComparison.Ordinal
                )
            )
            {
                throw new InvalidOperationException(
                    "Refusing to remove an unexpected runtime-cache path."
                );
            }
            if (Directory.Exists(resolved))
            {
                FileAttributes attributes = File.GetAttributes(resolved);
                bool reparsePoint = (attributes & FileAttributes.ReparsePoint) != 0;
                Directory.Delete(resolved, !reparsePoint);
            }
        }
        catch (IOException)
        {
            // A concurrent process or antivirus scan may briefly retain a temporary file.
        }
        catch (UnauthorizedAccessException)
        {
            // The payload is already usable; a stale incoming directory is harmless.
        }
    }

    private sealed class PayloadLocation
    {
        public PayloadLocation(string root, string sha256, string cacheStatus)
        {
            Root = root;
            Sha256 = sha256;
            CacheStatus = cacheStatus;
        }

        public string Root { get; private set; }
        public string Sha256 { get; private set; }
        public string CacheStatus { get; private set; }
    }
}
