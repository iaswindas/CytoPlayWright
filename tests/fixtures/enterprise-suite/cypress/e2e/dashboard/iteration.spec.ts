describe("Collection iteration", () => {
  beforeEach(() => {
    cy.visit("/dashboard/items");
  });

  it("iterates over item rows", () => {
    cy.get("[data-testid='item-row']").each(($row, index) => {
      cy.wrap($row).click();
      cy.wrap(index).then((position) => {
        cy.wrap(position).as("lastIndex");
      });
    });

    cy.get("@lastIndex").then((lastIndex) => {
      cy.contains(String(lastIndex)).should("be.visible");
    });
  });
});
