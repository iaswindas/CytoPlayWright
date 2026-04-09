describe("PDF compare", function () {
  it("preserves third-party fluent chains and CommonJS helpers", async function () {
    const comparePdf = require("compare-pdf");
    const helpers = require("../../support/helpers/commonjs-helper");
    const settings = helpers.getSettings();
    let comparisonResults = await new comparePdf()
      .actualPdfFile("invoice-actual.pdf")
      .baselinePdfFile("invoice-baseline.pdf")
      .cropPage(1, { width: 530, height: 210, x: 0, y: 415 })
      .compare();

    expect(settings.retries).to.eq(3);
    expect(comparisonResults.status).to.equal("passed");
  });
});
