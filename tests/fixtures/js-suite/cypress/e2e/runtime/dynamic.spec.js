describe("JavaScript migration safety", function () {
  it("handles dynamic objects, JSON requires, and normalized request bodies", function () {
    let dynamicConfig = {};
    dynamicConfig.retries = 3;

    const localData = require("../../fixtures/config.json");
    const mutableData = require("../../fixtures/config.json");
    mutableData.baseUrl = "https://override.example.test";

    cy.request("/api/settings").then((res) => {
      dynamicConfig.url = res.body.urls.base;
      expect(dynamicConfig.url).to.eq(localData.baseUrl);
    });
  });
});
