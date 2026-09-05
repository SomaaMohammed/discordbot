using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class BuildIdentity
{
    public const string Version = "job-smoke-test";
    public static readonly bool SigningRequired = false;
    public const string ExpectedPublisher = "";
    public const string ExpectedThumbprint = "";
}

internal static class JobSmokeHarness
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length >= 1 && args[0] == "quote-child")
            {
                string[] expected = QuoteProbeArguments();
                if (args.Length != expected.Length + 1)
                {
                    Console.Error.WriteLine("Quoted argument count changed in the child process.");
                    return 4;
                }
                for (int index = 0; index < expected.Length; index += 1)
                {
                    if (!string.Equals(args[index + 1], expected[index], StringComparison.Ordinal))
                    {
                        Console.Error.WriteLine("Quoted argument changed at index " + index + ".");
                        return 5;
                    }
                }
                return 0;
            }
            if (args.Length == 1 && args[0] == "quote")
            {
                string arguments = "quote-child";
                foreach (string argument in QuoteProbeArguments())
                {
                    arguments += " " + LauncherSupport.QuoteArgument(argument);
                }
                ProcessStartInfo start = new ProcessStartInfo
                {
                    FileName = Assembly.GetExecutingAssembly().Location,
                    Arguments = arguments,
                    WorkingDirectory = Environment.CurrentDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                return LauncherSupport.RunChild(start);
            }
            if (args.Length == 3 && args[0] == "resolve-db")
            {
                Console.WriteLine(
                    LauncherSupport.ResolveDatabaseFile(args[1], args[2])
                );
                return 0;
            }
            if (args.Length == 2 && args[0] == "normalize-root")
            {
                Console.WriteLine(LauncherSupport.NormalizeRoot(args[1]));
                return 0;
            }
            if (args.Length == 2 && args[0] == "child")
            {
                File.WriteAllText(
                    args[1],
                    Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
                );
                Thread.Sleep(TimeSpan.FromMinutes(2));
                return 0;
            }
            if (args.Length == 4 && args[0] == "hold")
            {
                using (SuperiorInstanceGuard guard =
                    SuperiorInstanceGuard.Acquire(args[1], args[2]))
                {
                    ProcessStartInfo start = new ProcessStartInfo
                    {
                        FileName = Assembly.GetExecutingAssembly().Location,
                        Arguments = "child " + LauncherSupport.QuoteArgument(args[3]),
                        WorkingDirectory = args[1],
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                    return LauncherSupport.RunChild(start);
                }
            }
            if (args.Length == 4 && args[0] == "probe")
            {
                using (SuperiorInstanceGuard guard =
                    SuperiorInstanceGuard.Acquire(args[1], args[2]))
                {
                    int priorChildId = int.Parse(args[3], CultureInfo.InvariantCulture);
                    try
                    {
                        using (Process priorChild = Process.GetProcessById(priorChildId))
                        {
                            if (!priorChild.HasExited)
                            {
                                Console.Error.WriteLine(
                                    "The prior launcher lock was released while its child was still alive."
                                );
                                return 3;
                            }
                        }
                    }
                    catch (ArgumentException)
                    {
                        // The job terminated the prior child before this lock was acquired.
                    }
                    return 0;
                }
            }
            Console.Error.WriteLine("Invalid job smoke harness arguments.");
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static string[] QuoteProbeArguments()
    {
        return new[]
        {
            "",
            "plain",
            "space value",
            "C:\\path with spaces\\",
            "embedded\"quote",
            "slashes\\\\before\"quote",
            "ends-with-two\\\\"
        };
    }
}
