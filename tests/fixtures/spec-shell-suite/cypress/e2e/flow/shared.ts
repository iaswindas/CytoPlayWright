describe("shared flow", () => {
  it("runs from a shell spec", () => {
    cy.get("[data-testid='shell-entry']").click();
  });
});
