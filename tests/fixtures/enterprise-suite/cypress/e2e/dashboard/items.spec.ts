describe("Dashboard items", () => {
  beforeEach(() => {
    cy.intercept("GET", "/api/items").as("getItems");
    cy.loginAs("manager");
    cy.visit("/dashboard/items");
  });

  it("loads inventory rows", () => {
    cy.wait("@getItems");
    cy.get("[data-testid='item-row']").should("contain.text", "Item A");
    cy.request({
      method: "POST",
      url: "/api/audit",
      body: { event: "view_items" }
    });
    cy.task("seed:items", { count: 3 });
  });
});
