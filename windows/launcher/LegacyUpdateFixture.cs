using System;
using System.Reflection;

[assembly: AssemblyTitle("Superior Bot legacy updater fixture")]
[assembly: AssemblyProduct("Superior Bot")]
[assembly: AssemblyVersion("7.2.8.0")]
[assembly: AssemblyFileVersion("7.2.8.0")]
[assembly: AssemblyInformationalVersion("7.2.8")]

internal static class LegacyUpdateFixture
{
    private static int Main(string[] args)
    {
        if (args.Length == 1 && string.Equals(args[0], "--version", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine("Superior Bot 7.2.8");
            return 0;
        }

        if (args.Length == 1 && string.Equals(args[0], "--check", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine("Legacy fixture configuration is valid.");
            return 0;
        }

        return 0;
    }
}
