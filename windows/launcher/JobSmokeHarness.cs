using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class BuildIdentity
{
    public const string Version = "job-smoke-test";
}

internal static class JobSmokeHarness
{
    private static int Main(string[] args)
    {
        try
        {
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
}
