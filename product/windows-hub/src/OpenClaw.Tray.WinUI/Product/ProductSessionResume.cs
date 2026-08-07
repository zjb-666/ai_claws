using OpenClaw.Connection;
using OpenClaw.Shared;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace OpenClawTray.Product;

/// <summary>
/// Resumes a previously logged-in product session without showing the login WebView,
/// so Gateway connect is not blocked behind an unattended login window after tray restarts.
/// </summary>
internal static class ProductSessionResume
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(20),
    };

    public static async Task<bool> TryResumeAsync(
        ProductConfig config,
        IGatewayConnectionManager connectionManager,
        GatewayRegistry gatewayRegistry,
        IOpenClawLogger? logger = null)
    {
        var accessToken = ProductAuthStore.TryLoadAccessToken();
        if (string.IsNullOrWhiteSpace(accessToken))
            return false;

        try
        {
            var bootstrap = await RequestBootstrapAsync(config, gatewayRegistry, accessToken)
                .ConfigureAwait(false);
            var matchingGateway = gatewayRegistry.FindByUrl(bootstrap.GatewayUrl);
            var identityDir = matchingGateway is null
                ? null
                : gatewayRegistry.GetIdentityDirectory(matchingGateway.Id);
            var hasStoredOperatorToken = identityDir is not null &&
                DeviceIdentity.HasStoredDeviceTokenForRole(identityDir, "operator");

            if (matchingGateway is not null &&
                hasStoredOperatorToken &&
                !StoredOperatorScopesIncludeAdmin(identityDir!) &&
                !string.IsNullOrWhiteSpace(bootstrap.SetupCode))
            {
                DeviceIdentity.TryClearDeviceToken(identityDir!);
                hasStoredOperatorToken = false;
            }

            var hasStaleBootstrap =
                matchingGateway is not null &&
                !string.IsNullOrWhiteSpace(matchingGateway.BootstrapToken);
            if (hasStaleBootstrap && !string.IsNullOrWhiteSpace(bootstrap.SetupCode))
            {
                if (identityDir is not null)
                    DeviceIdentity.TryClearDeviceToken(identityDir);
                hasStoredOperatorToken = false;
            }

            if (matchingGateway is not null && hasStoredOperatorToken)
            {
                await connectionManager.SwitchGatewayAsync(matchingGateway.Id)
                    .ConfigureAwait(false);
                logger?.Info($"[Product] Resumed session via stored operator token ({matchingGateway.Id})");
                return true;
            }

            if (string.IsNullOrWhiteSpace(bootstrap.SetupCode))
            {
                logger?.Warn("[Product] Silent resume skipped: no setup code and no stored operator token");
                return false;
            }

            var result = await connectionManager.ApplySetupCodeAsync(bootstrap.SetupCode)
                .ConfigureAwait(false);
            if (result.Outcome != SetupCodeOutcome.Success)
            {
                logger?.Warn($"[Product] Silent resume setup failed: {result.ErrorMessage}");
                return false;
            }

            logger?.Info("[Product] Resumed session via bootstrap setup code");
            return true;
        }
        catch (Exception ex)
        {
            logger?.Warn($"[Product] Silent resume failed: {ex.Message}");
            return false;
        }
    }

    private static async Task<DesktopBootstrap> RequestBootstrapAsync(
        ProductConfig config,
        GatewayRegistry gatewayRegistry,
        string accessToken)
    {
        var pairedGatewayUrls = gatewayRegistry.GetAll()
            .Where(record => DeviceIdentity.HasStoredDeviceTokenForRole(
                gatewayRegistry.GetIdentityDirectory(record.Id),
                "operator"))
            .Select(record => record.Url)
            .ToArray();
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{config.ProductApiBaseUrl}/api/desktop/bootstrap")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { pairedGatewayUrls }),
                Encoding.UTF8,
                "application/json"),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue(
            "Bearer",
            accessToken);
        using var response = await Http.SendAsync(request).ConfigureAwait(false);
        var payload = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException("平台暂时无法为此账号分配专属 Gateway。");

        using var document = JsonDocument.Parse(payload);
        var data = document.RootElement.GetProperty("data");
        var gatewayUrl = data.GetProperty("gatewayUrl").GetString();
        var setupCode = data.TryGetProperty("setupCode", out var setupCodeElement)
            ? setupCodeElement.GetString()
            : null;
        return !string.IsNullOrWhiteSpace(gatewayUrl)
            ? new DesktopBootstrap(gatewayUrl, setupCode)
            : throw new InvalidOperationException("平台返回的专属 Gateway 信息无效。");
    }

    private static bool StoredOperatorScopesIncludeAdmin(string identityDirectory)
    {
        var keyPath = Path.Combine(identityDirectory, "device-key-ed25519.json");
        if (!File.Exists(keyPath))
            return false;

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(keyPath));
            if (!document.RootElement.TryGetProperty("DeviceTokenScopes", out var scopes) ||
                scopes.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            foreach (var scope in scopes.EnumerateArray())
            {
                if (scope.ValueKind == JsonValueKind.String &&
                    string.Equals(scope.GetString(), "operator.admin", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }
        catch
        {
            return false;
        }

        return false;
    }

    private sealed record DesktopBootstrap(string GatewayUrl, string? SetupCode);
}
