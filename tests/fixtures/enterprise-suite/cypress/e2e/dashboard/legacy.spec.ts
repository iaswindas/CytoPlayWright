describe("Legacy dashboard", () => {
  it("needs manual review for callback chaining", () => {
    let captured = "";
    cy.get("[data-testid='legacy']").then(() => {
      captured = "legacy";
    });
  });
});
