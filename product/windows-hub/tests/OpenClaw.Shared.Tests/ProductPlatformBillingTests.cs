using OpenClaw.Shared;
using Xunit;

namespace OpenClaw.Shared.Tests;

public class ProductPlatformBillingTests
{
    [Theory]
    [InlineData("qwen3_6_plus")]
    [InlineData("deepseek_v4_pro")]
    [InlineData("glm_5")]
    [InlineData("juyuancloud/qwen3_6_plus")]
    public void IsAllowedModel_True_ForWhitelist(string id)
    {
        Assert.True(ProductPlatformBilling.IsAllowedModel(id));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("gpt-4o")]
    [InlineData("openai/gpt-5")]
    public void IsAllowedModel_False_ForOthers(string? id)
    {
        Assert.False(ProductPlatformBilling.IsAllowedModel(id));
    }

    [Fact]
    public void FilterModelsList_KeepsOnlyWhitelist_AndClearsRequiresAuth()
    {
        var input = new ModelsListInfo
        {
            Models =
            {
                new ModelInfo { Id = "qwen3_6_plus", RequiresAuth = true, IsConfigured = false },
                new ModelInfo { Id = "gpt-4o", IsConfigured = true },
                new ModelInfo { Id = "deepseek_v4_pro", IsConfigured = true },
            }
        };

        var filtered = ProductPlatformBilling.FilterModelsList(input);

        Assert.Equal(2, filtered.Models.Count);
        Assert.All(filtered.Models, m => Assert.False(m.RequiresAuth));
        Assert.Contains(filtered.Models, m => m.Id == "qwen3_6_plus" && m.IsConfigured);
        Assert.Contains(filtered.Models, m => m.Id == "deepseek_v4_pro");
    }

    [Fact]
    public void TryMapUserFacingError_MapsInsufficientPoints()
    {
        var mapped = ProductPlatformBilling.TryMapUserFacingError(
            "vendor rejected",
            ProductPlatformBilling.InsufficientPointsCode);

        Assert.NotNull(mapped);
        Assert.Contains("算力", mapped);
    }

    [Fact]
    public void TryMapUserFacingError_ReturnsNull_ForUnrelated()
    {
        Assert.Null(ProductPlatformBilling.TryMapUserFacingError("connection refused"));
    }

    [Fact]
    public void TryMapUserFacingError_MapsFailedBeforeReply_ToNewSessionGuidance()
    {
        var mapped = ProductPlatformBilling.TryMapUserFacingError(
            "Agent failed before reply: 503 chat completions unavailable");

        Assert.NotNull(mapped);
        Assert.Contains("新建会话", mapped);
        Assert.Contains("出口", mapped);
    }

    [Fact]
    public void TryMapUserFacingError_Maps502FetchFailed_ToOutletGuidance()
    {
        var mapped = ProductPlatformBilling.TryMapUserFacingError("502 fetch failed");

        Assert.NotNull(mapped);
        Assert.Contains("算力出口", mapped);
        Assert.Contains("新建会话", mapped);
    }

    [Theory]
    [InlineData("503 chat completions unavailable")]
    [InlineData("502 fetch failed")]
    [InlineData("Embedded agent failed before reply: boom")]
    [InlineData("助手本次未能生成回复。请点「新建会话」清空上下文后再试；若仍失败，请联系运维检查 Gateway 与算力出口（不一定是模型白名单问题）。")]
    public void SuggestsNewSessionRecovery_True_ForRecoverableFailures(string message)
    {
        Assert.True(ProductPlatformBilling.SuggestsNewSessionRecovery(message));
    }

    [Fact]
    public void SuggestsNewSessionRecovery_False_ForUnrelated()
    {
        Assert.False(ProductPlatformBilling.SuggestsNewSessionRecovery("connection refused"));
    }

    [Fact]
    public void LockClientSurfaces_DefaultsTrue()
    {
        Assert.True(ProductPlatformBilling.LockClientSurfaces);
    }

    [Fact]
    public void AllowedModelIds_MatchPlatformWhitelist()
    {
        Assert.Equal(
            new[] { "qwen3_6_plus", "deepseek_v4_pro", "glm_5" },
            ProductPlatformBilling.AllowedModelIds);
    }
}
