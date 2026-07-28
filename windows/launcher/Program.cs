using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );

            if (args.Length == 1 && EqualsOption(args[0], "--version"))
            {
                string version = File.ReadAllText(Path.Combine(root, "VERSION")).Trim();
                Console.WriteLine("Superior Bot " + version);
                return 0;
            }

            if (args.Length == 1 && EqualsOption(args[0], "--check"))
            {
                return RunNode(root, Path.Combine(root, "tools", "check-portable.mjs"));
            }

            if (args.Length == 1 && EqualsOption(args[0], "--help"))
            {
                Console.WriteLine("SuperiorBot.exe [--check | --version | --help]");
                Console.WriteLine("Run without an option to start the Discord bot.");
                return 0;
            }

            if (args.Length != 0)
            {
                Console.Error.WriteLine("Unknown option. Use --help for supported options.");
                return 2;
            }

            if (!File.Exists(Path.Combine(root, ".env")))
            {
                Console.Error.WriteLine(
                    "Missing .env beside SuperiorBot.exe. Copy .env.example to .env and add your Discord token."
                );
                return 2;
            }

            return RunNode(root, Path.Combine(root, "app", "dist", "src", "index.js"));
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

    private static int RunNode(string root, string script)
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
            Arguments = QuoteArgument(script),
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = false
        };

        using (Process process = Process.Start(start))
        {
            if (process == null)
            {
                Console.Error.WriteLine("Unable to start the bundled Node runtime.");
                return 1;
            }
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
