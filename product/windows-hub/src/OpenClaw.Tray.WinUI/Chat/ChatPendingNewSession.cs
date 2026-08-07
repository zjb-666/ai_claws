namespace OpenClawTray.Chat;

/// <summary>
/// Client-local pending-new compose keys (ClawWork-style).
/// Clicking New Session switches the UI to a clean empty page immediately;
/// <c>sessions.create</c> runs only on the first send so users never keep
/// chatting inside a heavy/broken transcript while waiting on the gateway.
/// </summary>
internal static class ChatPendingNewSession
{
    public const string KeyPrefix = "local:pending-new:";

    public static string AllocateKey() =>
        KeyPrefix + Guid.NewGuid().ToString("N");

    public static bool IsPendingKey(string? sessionKey) =>
        !string.IsNullOrEmpty(sessionKey) &&
        sessionKey.StartsWith(KeyPrefix, StringComparison.Ordinal);
}
