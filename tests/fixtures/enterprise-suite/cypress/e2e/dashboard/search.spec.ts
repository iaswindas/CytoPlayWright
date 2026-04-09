describe("Search", () => {
  beforeEach(() => {
    cy.visit("/dashboard/search");
  });

  it("filters by keyword", () => {
    cy.get("[data-testid='search-input']").type("quota");
    cy.get("[data-testid='search-submit']").click();
    cy.get("[data-testid='results']").should("contain", "quota");
  });
});
