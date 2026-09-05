using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;

internal static class AuthenticodeSupport
{
    private const uint WtdUiNone = 2;
    private const uint WtdRevokeWholeChain = 1;
    private const uint WtdChoiceFile = 1;
    private const uint WtdStateActionIgnore = 0;
    private const uint WtdRevocationCheckChainExcludeRoot = 0x00000080;
    private const string CounterSignatureOid = "1.2.840.113549.1.9.6";
    private const string Rfc3161TimestampOid = "1.3.6.1.4.1.311.3.3.1";

    private static readonly Guid WintrustActionGenericVerifyV2 = new Guid(
        "00AAC56B-CD44-11D0-8CC2-00C04FC295EE"
    );

    public static void VerifyFile(string fileName, string description)
    {
        if (!BuildIdentity.SigningRequired)
        {
            return;
        }
        string resolved = Path.GetFullPath(fileName);
        if (!File.Exists(resolved))
        {
            throw new InvalidDataException(description + " is missing.");
        }

        WINTRUST_FILE_INFO file = new WINTRUST_FILE_INFO(resolved);
        IntPtr filePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
        try
        {
            Marshal.StructureToPtr(file, filePointer, false);
            WINTRUST_DATA data = new WINTRUST_DATA(filePointer);
            Guid policy = WintrustActionGenericVerifyV2;
            uint result = WinVerifyTrust(IntPtr.Zero, ref policy, ref data);
            if (result != 0)
            {
                throw new InvalidDataException(
                    description + " has an invalid, untrusted, unsigned, or improperly timestamped Authenticode signature (0x"
                        + result.ToString("X8")
                        + ")."
                );
            }
        }
        finally
        {
            Marshal.DestroyStructure(filePointer, typeof(WINTRUST_FILE_INFO));
            Marshal.FreeHGlobal(filePointer);
        }

        using (X509Certificate2 signer = new X509Certificate2(X509Certificate.CreateFromSignedFile(resolved)))
        {
            if (
                !string.Equals(
                    signer.Subject,
                    BuildIdentity.ExpectedPublisher,
                    StringComparison.Ordinal
                )
            )
            {
                throw new InvalidDataException(
                    description + " was not signed by the expected publisher."
                );
            }
            if (
                !string.Equals(
                    NormalizeThumbprint(signer.Thumbprint),
                    NormalizeThumbprint(BuildIdentity.ExpectedThumbprint),
                    StringComparison.Ordinal
                )
            )
            {
                throw new InvalidDataException(
                    description + " was not signed by the expected certificate."
                );
            }
        }

        if (!HasAuthenticodeTimestamp(resolved))
        {
            throw new InvalidDataException(
                description + " has no Authenticode timestamp."
            );
        }
    }

    private static string NormalizeThumbprint(string value)
    {
        return (value ?? "").Replace(" ", "").ToUpperInvariant();
    }

    private static bool HasAuthenticodeTimestamp(string fileName)
    {
        SignedCms signature = new SignedCms();
        try
        {
            signature.Decode(ReadAuthenticodeSignature(fileName));
        }
        catch (CryptographicException error)
        {
            throw new InvalidDataException(
                "The Authenticode signature could not be decoded.",
                error
            );
        }
        foreach (SignerInfo signer in signature.SignerInfos)
        {
            if (signer.CounterSignerInfos.Count > 0)
            {
                return true;
            }
            foreach (CryptographicAttributeObject attribute in signer.UnsignedAttributes)
            {
                string oid = attribute.Oid == null ? "" : attribute.Oid.Value;
                if (
                    (oid == CounterSignatureOid || oid == Rfc3161TimestampOid)
                    && attribute.Values.Count > 0
                )
                {
                    return true;
                }
            }
        }
        return false;
    }

    private static byte[] ReadAuthenticodeSignature(string fileName)
    {
        using (FileStream stream = File.Open(fileName, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (BinaryReader reader = new BinaryReader(stream))
        {
            if (stream.Length < 64 || reader.ReadUInt16() != 0x5A4D)
            {
                throw new InvalidDataException("The signed file is not a valid PE image.");
            }
            stream.Position = 0x3C;
            int peOffset = reader.ReadInt32();
            if (peOffset < 0 || peOffset > stream.Length - 24)
            {
                throw new InvalidDataException("The signed PE header is invalid.");
            }
            stream.Position = peOffset;
            if (reader.ReadUInt32() != 0x00004550)
            {
                throw new InvalidDataException("The signed PE signature is invalid.");
            }
            stream.Position = peOffset + 24;
            ushort optionalMagic = reader.ReadUInt16();
            long dataDirectoryOffset;
            if (optionalMagic == 0x10B)
            {
                dataDirectoryOffset = peOffset + 24 + 96;
            }
            else if (optionalMagic == 0x20B)
            {
                dataDirectoryOffset = peOffset + 24 + 112;
            }
            else
            {
                throw new InvalidDataException("The signed PE optional header is invalid.");
            }
            long securityDirectoryOffset = dataDirectoryOffset + (8 * 4);
            if (securityDirectoryOffset > stream.Length - 8)
            {
                throw new InvalidDataException("The signed PE security directory is missing.");
            }
            stream.Position = securityDirectoryOffset;
            uint certificateOffset = reader.ReadUInt32();
            uint certificateSize = reader.ReadUInt32();
            if (
                certificateOffset == 0
                || certificateSize < 8
                || certificateOffset > stream.Length - certificateSize
            )
            {
                throw new InvalidDataException("The Authenticode certificate table is invalid.");
            }
            stream.Position = certificateOffset;
            uint certificateLength = reader.ReadUInt32();
            reader.ReadUInt16();
            ushort certificateType = reader.ReadUInt16();
            if (
                certificateType != 0x0002
                || certificateLength < 8
                || certificateLength > certificateSize
                || certificateLength - 8 > int.MaxValue
            )
            {
                throw new InvalidDataException("The Authenticode WIN_CERTIFICATE is invalid.");
            }
            byte[] encoded = reader.ReadBytes((int)certificateLength - 8);
            if (encoded.Length != (int)certificateLength - 8)
            {
                throw new EndOfStreamException("The Authenticode signature is truncated.");
            }
            return encoded;
        }
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint WinVerifyTrust(
        IntPtr window,
        ref Guid actionId,
        ref WINTRUST_DATA trustData
    );

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private sealed class WINTRUST_FILE_INFO
    {
        public uint structureSize = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
        public string filePath;
        public IntPtr fileHandle = IntPtr.Zero;
        public IntPtr knownSubject = IntPtr.Zero;

        public WINTRUST_FILE_INFO(string fileName)
        {
            filePath = fileName;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WINTRUST_DATA
    {
        public uint structureSize;
        public IntPtr policyCallbackData;
        public IntPtr sipClientData;
        public uint uiChoice;
        public uint revocationChecks;
        public uint unionChoice;
        public IntPtr fileInfo;
        public uint stateAction;
        public IntPtr stateData;
        public string urlReference;
        public uint providerFlags;
        public uint uiContext;

        public WINTRUST_DATA(IntPtr fileInformation)
        {
            structureSize = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
            policyCallbackData = IntPtr.Zero;
            sipClientData = IntPtr.Zero;
            uiChoice = WtdUiNone;
            revocationChecks = WtdRevokeWholeChain;
            unionChoice = WtdChoiceFile;
            fileInfo = fileInformation;
            stateAction = WtdStateActionIgnore;
            stateData = IntPtr.Zero;
            urlReference = null;
            providerFlags = WtdRevocationCheckChainExcludeRoot;
            uiContext = 0;
        }
    }
}
