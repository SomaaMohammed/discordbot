using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;

internal static class Program
{
    private const string PayloadResourceName = "SuperiorBot.Payload.zip";

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && EqualsOption(args[0], "--help"))
            {
                Console.WriteLine("SuperiorBot.exe [--check | --version | --help]");
                Console.WriteLine("Run without an option to start the Discord bot.");
                return 0;
            }

            bool showVersion = args.Length == 1 && EqualsOption(args[0], "--version");
            bool checkOnly = args.Length == 1 && EqualsOption(args[0], "--check");
            if (args.Length != 0 && !showVersion && !checkOnly)
            {
                Console.Error.WriteLine("Unknown option. Use --help for supported options.");
                return 2;
            }

            string applicationRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );
            string payloadRoot = EnsurePayload();

            if (showVersion)
            {
                string version = File.ReadAllText(Path.Combine(payloadRoot, "VERSION")).Trim();
                Console.WriteLine("Superior Bot " + version);
                return 0;
            }

            string environmentFile = ResolveEnvironmentFile(applicationRoot);
            if (!File.Exists(environmentFile))
            {
                Console.Error.WriteLine(
                    "Missing .env beside SuperiorBot.exe. Copy .env.example to .env and add your Discord token."
                );
                return 2;
            }

            string script = checkOnly
                ? Path.Combine(payloadRoot, "tools", "check-portable.mjs")
                : Path.Combine(payloadRoot, "app", "dist", "src", "index.js");
            return RunNode(applicationRoot, payloadRoot, environmentFile, script, checkOnly);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Superior Bot launcher failed: " + error.Message);
            return 1;
        }
    }

    private static bool EqualsOption(string value, string expected)
    {
        return string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveEnvironmentFile(string applicationRoot)
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

    private static int RunNode(
        string applicationRoot,
        string payloadRoot,
        string environmentFile,
        string script,
        bool checkOnly
    )
    {
        string node = Path.Combine(payloadRoot, "runtime", "node.exe");
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
            Arguments = QuoteArgument(script),
            WorkingDirectory = applicationRoot,
            UseShellExecute = false,
            CreateNoWindow = false
        };
        start.EnvironmentVariables["ENV_FILE"] = environmentFile;
        start.EnvironmentVariables["SUPERIOR_APPLICATION_ROOT"] = applicationRoot;
        if (checkOnly)
        {
            start.EnvironmentVariables["SUPERIOR_PORTABLE_EXPECT_ROOT"] = applicationRoot;
        }

        using (Process process = Process.Start(start))
        {
            if (process == null)
            {
                Console.Error.WriteLine("Unable to start the embedded Node runtime.");
                return 1;
            }
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static string EnsurePayload()
    {
        string localApplicationData = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData
        );
        if (string.IsNullOrWhiteSpace(localApplicationData))
        {
            throw new InvalidOperationException("Windows did not provide a local application-data folder.");
        }

        string cacheRoot = Path.Combine(localApplicationData, "SuperiorBot", "payloads");
        Directory.CreateDirectory(cacheRoot);
        string incomingRoot = Path.Combine(cacheRoot, ".incoming-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(incomingRoot);

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

            string payloadHash = ComputeSha256(archivePath);
            string installedRoot = Path.Combine(cacheRoot, payloadHash);
            if (IsReadyPayload(installedRoot, payloadHash))
            {
                return FindPortableRoot(installedRoot);
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
            string portableRoot = FindPortableRoot(contentRoot);
            ValidatePortableRoot(portableRoot);
            File.WriteAllText(Path.Combine(contentRoot, ".ready"), payloadHash);

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
            }

            return FindPortableRoot(installedRoot);
        }
        finally
        {
            TryDeleteDirectory(incomingRoot);
        }
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

    private static void ExtractArchiveSafely(string archivePath, string destinationRoot)
    {
        string destinationPrefix = Path.GetFullPath(destinationRoot).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        ) + Path.DirectorySeparatorChar;

        using (ZipArchive archive = ZipFile.OpenRead(archivePath))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
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
                    continue;
                }

                string parent = Path.GetDirectoryName(destination);
                if (!string.IsNullOrEmpty(parent))
                {
                    Directory.CreateDirectory(parent);
                }
                entry.ExtractToFile(destination, false);
            }
        }
    }

    private static bool IsReadyPayload(string installedRoot, string expectedHash)
    {
        if (!Directory.Exists(installedRoot))
        {
            return false;
        }
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
            Path.Combine(portableRoot, "VERSION"),
            Path.Combine(portableRoot, "runtime", "node.exe"),
            Path.Combine(portableRoot, "tools", "check-portable.mjs"),
            Path.Combine(portableRoot, "app", "dist", "src", "index.js")
        };
        foreach (string requiredFile in requiredFiles)
        {
            if (!File.Exists(requiredFile))
            {
                throw new InvalidDataException("The embedded payload is incomplete.");
            }
        }
    }

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, true);
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

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
